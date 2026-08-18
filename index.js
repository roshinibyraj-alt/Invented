'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bot = require('./cricket-bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.get('/healthz', (_, r) => r.sendStatus(200));
app.get('/api/hedge/status', (_, r) => { try { r.json(bot.buildState()); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });
app.post('/api/hedge/pause', (_, r) => { try { r.json(bot.pauseTrading()); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });
app.post('/api/hedge/resume', (_, r) => { try { r.json(bot.resumeTrading()); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });
app.post('/api/hedge/set-mode', (req, r) => { const { live } = req.body || {}; if (typeof live !== 'boolean') return r.status(400).json({ ok: false, error: 'Missing "live" boolean' }); try { r.json(bot.setMode(live)); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });

const DASH = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Mining BTC Martingale</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:12px;font-weight:bold;-webkit-text-size-adjust:100%;overflow-x:hidden}
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #ffaa00;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:16px;color:#fff}.logo span{color:#00ccff}
.badge{padding:3px 10px;border-radius:20px;font-size:10px;font-weight:bold}
.badge-dem{background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}
.badge-live{background:#ff475722;color:#ff6b7a;border:1px solid #ff4757;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.btns{display:flex;gap:6px;padding:8px 14px 0;flex-wrap:wrap}
.btns button{background:#00ccff;color:#001018;border:none;padding:6px 10px;border-radius:6px;font-weight:bold;cursor:pointer;font-family:inherit;font-size:11px}
.btns button.pause{background:#ffcc00;color:#000}
.btns button.resume{background:#00ff88;color:#000}
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
.current-win{background:#111;border:1px solid #333;border-radius:8px;padding:10px;margin-bottom:8px}
.cw-label{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.cw-phase{font-size:14px;font-weight:bold;color:#ffcc00;margin-bottom:6px}
.cw-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.cw-item{font-size:11px}
.cw-item .lbl{color:#888;font-size:8px;text-transform:uppercase}
.cw-item .val{font-size:15px;font-weight:bold;color:#fff}
.cw-item .val.up{color:#00ccff}.cw-item .val.dn{color:#aa88ff}
.trade-card{background:#111;border:1px solid #444;border-radius:6px;padding:8px 10px;margin-bottom:6px}
.tc-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.tc-level{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:bold}
.tc-base{background:#00ccff22;color:#00ccff;border:1px solid #00ccff}
.tc-mart{background:#ffcc0022;color:#ffcc00;border:1px solid #ffcc00}
.tc-side{font-size:12px;font-weight:bold}
.tc-side.up{color:#00ccff}.tc-side.dn{color:#aa88ff}
.tc-details{display:flex;gap:16px;flex-wrap:wrap}
.tc-detail{font-size:10px}
.tc-detail .lbl{color:#666;font-size:7px;text-transform:uppercase}
.tc-detail .val{font-size:14px;font-weight:bold;color:#fff}
.history-list{max-height:300px;overflow-y:auto}
.h-item{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #1a1a1a;font-size:10px}
.h-result{font-size:11px;font-weight:bold;padding:2px 6px;border-radius:4px}
.h-win{background:#00ff8822;color:#00ff88}
.h-loss{background:#ff444422;color:#ff4444}
.h-pnl{font-size:12px;font-weight:bold}
.log-box{margin:8px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px;max-height:200px;overflow-y:auto;font-size:9px;line-height:1.4;white-space:nowrap;-webkit-overflow-scrolling:touch}
@media(max-width:600px){.log-box{margin:6px 10px 0}}
.log-box div{padding:1px 0}
.chart-box{margin:8px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
@media(max-width:600px){.chart-box{margin:6px 10px 0}}
.chart-box canvas{width:100%;height:120px;background:#111;border-radius:6px}
</style></head><body>
<div class="hd"><div><div class="logo">Mining <span>BTC Martingale</span></div></div><div class="badge badge-dem" id="mode-badge">DEMO</div></div>
<div class="btns"><button onclick="fetch('/api/hedge/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})" class="pause">Pause</button><button onclick="fetch('/api/hedge/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})" class="resume">Resume</button></div>

<div class="stats-row" id="stats-row"></div>

<div class="chart-box"><canvas id="eq-chart"></canvas></div>

<div class="panel" id="panel-m5"><div class="p-hd"><div class="p-title">5 Minute Windows</div><div class="p-badge" id="m5-badge">--</div></div><div class="p-body" id="m5-body"></div></div>
<div class="panel" id="panel-m15"><div class="p-hd"><div class="p-title">15 Minute Windows</div><div class="p-badge" id="m15-badge">--</div></div><div class="p-body" id="m15-body"></div></div>

<div class="log-box" id="log-box"></div>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io(),latest={m5:null,m15:null},allLogs=[];
var $=function(id){return document.getElementById(id)};
var fmt2=function(n){return n!=null?n.toFixed(2):'--'};
var sgn=function(n){return n>0?'+$'+fmt2(n):n<0?'-$'+fmt2(Math.abs(n)):'$0.00'};
var pC=function(n){return n>0?'pos':n<0?'neg':''};

function panelHtml(st,label){
  if(!st)return'<div style="color:#666;padding:10px">Waiting for data...</div>';
  var h='';
  // Current window
  var cur=st.current&&st.current.btc;
  if(cur&&cur.discovered){
    h+='<div class="current-win">';
    h+='<div class="cw-label">Active Window</div>';
    h+='<div class="cw-phase">'+cur.phase.toUpperCase()+' — '+cur.slug+'</div>';
    h+='<div class="cw-row">';
    h+='<div class="cw-item"><div class="lbl">Equity</div><div class="val '+pC((cur.totalCost||0)*-1)+'">$'+fmt2(st.equity)+'</div></div>';
    h+='<div class="cw-item"><div class="lbl">Window P&L</div><div class="val '+pC(cur.pnl)+'">'+sgn(cur.pnl||0)+'</div></div>';
    h+='<div class="cw-item"><div class="lbl">Cost</div><div class="val">$'+fmt2(cur.totalCost)+'</div></div>';
    h+='</div>';
    // Show each buy as a card
    if(cur.buys&&cur.buys.length){
      for(var i=0;i<cur.buys.length;i++){
        var b=cur.buys[i];
        var isBase=i===0;
        var levelClass=isBase?'tc-base':'tc-mart';
        var levelLabel=isBase?'BASE BET':'MARTINGALE #'+b.level;
        h+='<div class="trade-card">';
        h+='<div class="tc-header"><span class="tc-level '+levelClass+'">'+levelLabel+'</span><span class="tc-side '+b.side.toLowerCase()+'">'+b.side.toUpperCase()+'</span></div>';
        h+='<div class="tc-details">';
        h+='<div class="tc-detail"><div class="lbl">Shares</div><div class="val">'+b.shares.toFixed(2)+'sh</div></div>';
        h+='<div class="tc-detail"><div class="lbl">Price</div><div class="val">@'+b.price.toFixed(3)+'</div></div>';
        h+='<div class="tc-detail"><div class="lbl">Cost</div><div class="val">$'+fmt2(b.cost)+'</div></div>';
        h+='<div class="tc-detail"><div class="lbl">Bet</div><div class="val">$'+fmt2(b.dollars)+'</div></div>';
        h+='</div></div>';
      }
    }
    h+='</div>';
  }
  // Pending sells
  if(cur&&cur.sells&&cur.sells.length){
    h+='<div style="margin-top:6px;font-size:9px;color:#ff8800">';
    for(var j=0;j<cur.sells.length;j++){
      var s=cur.sells[j];
      h+='🛑 Stop: sold '+s.shares.toFixed(2)+'sh @'+s.price.toFixed(3)+' rec=$'+fmt2(s.proceeds)+'<br>';
    }
    h+='</div>';
  }
  // History
  var hist=st.history||[];
  if(hist.length){
    h+='<div style="margin-top:10px;font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Recent Windows</div>';
    h+='<div class="history-list">';
    for(var k=0;k<Math.min(hist.length,20);k++){
      var hw=hist[k];
      var resClass=hw.win===true?'h-win':hw.win===false?'h-loss':'';
      var resText=hw.skipped?'SKIP':hw.win===true?'WIN':'LOSS';
      var legs=hw.legs||[];
      var buyInfo='';
      for(var l=0;l<legs.length;l++){
        buyInfo+=legs[l].side.toUpperCase()+' '+legs[l].shares.toFixed(1)+'sh';
        if(l<legs.length-1)buyInfo+', ';
      }
      h+='<div class="h-item">';
      h+='<span style="color:#666">'+hw.slug.replace('btc-updown-'+(label==='5m'?'5m':'15m')+'-','')+'</span>';
      h+='<span style="font-size:8px;color:#aaa">'+legs.length+'leg</span>';
      h+='<span class="h-result '+resClass+'">'+resText+'</span>';
      h+='<span class="h-pnl '+pC(hw.pnl)+'">'+sgn(hw.pnl)+'</span>';
      h+='</div>';
    }
    h+='</div>';
  }
  if(!cur||!cur.discovered)h+='<div style="color:#666;padding:8px;text-align:center">Waiting for window discovery...</div>';
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
    ctx.strokeStyle=c.color;ctx.globalAlpha=.5;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(pad,yA(c.cap));ctx.lineTo(W-pad,yA(c.cap));ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.beginPath();ctx.moveTo(xA(0,d.length),yA(vals[0]));for(var i=1;i<d.length;i++)ctx.lineTo(xA(i,d.length),yA(vals[i]));
    ctx.strokeStyle=c.color;ctx.lineWidth=2;ctx.stroke();
    ctx.lineTo(xA(d.length-1,d.length),H-pad);ctx.lineTo(xA(0,d.length),H-pad);ctx.closePath();ctx.fillStyle=c.color+'11';ctx.fill();
    ctx.fillStyle=c.color;ctx.beginPath();ctx.arc(xA(d.length-1,d.length),yA(vals[vals.length-1]),3.5,0,Math.PI*2);ctx.fill();
  });
  ctx.font='9px monospace';ctx.fillStyle='#888';ctx.fillText('$'+max.toFixed(0),4,14);ctx.fillText('$'+min.toFixed(0),4,H-4);
}

function render(){
  // Stats
  var combined5=latest.m5||{},combined15=latest.m15||{};
  var totalPnl=(combined5.realizedPnl||0)+(combined15.realizedPnl||0);
  var totalBankroll=(combined5.bankroll||0)+(combined15.bankroll||0);
  var totalCapital=(combined5.startingCapital||0)+(combined15.startingCapital||0);
  var totalWins=(combined5.wins||0)+(combined15.wins||0);
  var totalLosses=(combined5.losses||0)+(combined15.losses||0);
  var totalDecided=totalWins+totalLosses;
  var winRate=totalDecided>0?((totalWins/totalDecided)*100).toFixed(1)+'%':'--';
  var totalEquity=(combined5.equity||totalBankroll)+(combined15.equity||0)-(combined5.startingCapital||0)-(combined15.startingCapital||0)+totalBankroll;
  $('stats-row').innerHTML=[
    '<div class="st"><div class="st-l">Bankroll</div><div class="st-v">$'+fmt2(totalBankroll)+'</div></div>',
    '<div class="st"><div class="st-l">Realized P&L</div><div class="st-v '+pC(totalPnl)+'">'+sgn(totalPnl)+'</div></div>',
    '<div class="st"><div class="st-l">Wins / Losses</div><div class="st-v">'+totalWins+'W / '+totalLosses+'L</div></div>',
    '<div class="st"><div class="st-l">Win Rate</div><div class="st-v">'+winRate+'</div></div>',
  ].join('');

  // Panels
  $('m5-body').innerHTML=panelHtml(latest.m5,'5m');
  $('m5-badge').textContent=(latest.m5?latest.m5.wins+'W/'+latest.m5.losses+'L':'--')+' | $'+fmt2(latest.m5?latest.m5.realizedPnl:0);
  $('m15-body').innerHTML=panelHtml(latest.m15,'15m');
  $('m15-badge').textContent=(latest.m15?latest.m15.wins+'W/'+latest.m15.losses+'L':'--')+' | $'+fmt2(latest.m15?latest.m15.realizedPnl:0);

  // Mode badge
  var live=(latest.m5&&!latest.m5.dryRun)||(latest.m15&&!latest.m15.dryRun);
  $('mode-badge').className='badge '+(live?'badge-live':'badge-dem');
  $('mode-badge').textContent=live?'LIVE':'DEMO';

  drawChart();
}

function renderLogs(){
  var el=$('log-box');if(!el)return;
  var wasAtBottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=allLogs.slice(-150).map(function(l){
    var c='';
    if(l.indexOf('WIN')>=0)c=' style="color:#00ff88"';
    else if(l.indexOf('LOSS')>=0||l.indexOf('STOP')>=0)c=' style="color:#ff4444"';
    else if(l.indexOf('P&L')>=0||l.indexOf('💰')>=0)c=' style="color:#ffcc00"';
    else if(l.indexOf('📡')>=0||l.indexOf('🔌')>=0)c=' style="color:#00ccff"';
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
    if(st.m5)latest.m5=st.m5;if(st.m15)latest.m15=st.m15;render()
  }catch(e){}
},10000);
render();
</script></body></html>`;

app.get('/', (_, res) => { res.type('html').send(DASH); });

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log('⛏ BTC Martingale Bot — 5m + 15m independent windows');
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
