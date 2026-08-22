'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const CAPITAL = Number(process.env.CAPITAL || 4000);
const BASE_STAKE_USD = Number(process.env.BASE_STAKE_USD || 50);
const MARTINGALE_MULTIPLIER = Number(process.env.MARTINGALE_MULTIPLIER || 2.5);
const MAX_MARTINGALES = Number(process.env.MAX_MARTINGALES || 3);
const ENTRY_MIN = Number(process.env.ENTRY_MIN || 0.60);
const ENTRY_MAX = Number(process.env.ENTRY_MAX || 0.70);
const STOP_LOSS_PRICE = Number(process.env.STOP_LOSS_PRICE || 0.45);
const ENTRY_START_SECOND = Number(process.env.ENTRY_START_SECOND || 30);
const ENTRY_END_SECOND = Number(process.env.ENTRY_END_SECOND || 270);

let engine = null;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const PORT = process.env.PORT || 8080;

app.get('/healthz', (_, request) => request.sendStatus(200));
app.get('/api/hedge/status', (_, response) => {
  try { response.json({ engine: engine ? engine.buildState() : null }); }
  catch (error) { response.status(500).json({ ok: false, error: error.message }); }
});
app.post('/api/hedge/pause', (_, response) => {
  try { if (engine) engine.pauseTrading(); response.json({ ok: true }); }
  catch (error) { response.status(500).json({ ok: false, error: error.message }); }
});
app.post('/api/hedge/resume', (_, response) => {
  try { if (engine) engine.resumeTrading(); response.json({ ok: true }); }
  catch (error) { response.status(500).json({ ok: false, error: error.message }); }
});

const DASHBOARD = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BTC Martingale Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#fff;font-family:'Courier New',monospace;font-weight:bold;font-size:13px;-webkit-text-size-adjust:100%}
.header{padding:12px;background:#050505;border-bottom:3px solid #00ccff;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
.title{font-size:18px}.title span{color:#00ccff}
.badge{border:1px solid #333;border-radius:20px;padding:4px 10px;font-size:11px}
.demo{color:#ffcc00;background:#ffcc0018}.live{color:#ff5566;background:#ff556618}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;padding:9px}
.box,.card{background:#030303;border:1px solid #333;border-radius:7px;padding:8px}
.label{color:#888;font-size:9px;text-transform:uppercase}.value{font-size:16px;margin-top:2px}
.positive{color:#00ff88}.negative{color:#ff4444}.accent{color:#00ccff}.warning{color:#ffcc00}
.main{margin:0 9px 9px;border:1px solid #333;border-radius:8px;overflow:hidden}
.main-head{padding:9px;background:#060606;border-bottom:1px solid #222;display:flex;justify-content:space-between;gap:8px;font-size:12px}
.body{padding:10px}.prices{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;text-align:center;margin-bottom:9px}
.price{font-size:25px}.count{font-size:22px;color:#ffcc00}
.position{min-height:82px}.pos-line{font-size:17px;margin-bottom:5px}.sub{font-size:14px;color:#ddd;line-height:1.45}
.flat{color:#888;font-size:15px}.history{max-height:300px;overflow:auto;margin-top:9px}
.row{display:flex;justify-content:space-between;gap:7px;padding:7px 0;border-top:1px solid #181818;font-size:12px;flex-wrap:wrap}
.result{padding:2px 6px;border-radius:4px}.win{color:#00ff88;background:#00ff8822}.loss{color:#ff4444;background:#ff444422}
.logs{height:230px;overflow:auto;padding:10px;border-top:1px solid #222;background:#010101;font-size:12px;line-height:1.45;white-space:pre}
@media(max-width:600px){.stats{grid-template-columns:repeat(2,1fr);padding:7px}.title{font-size:16px}.price{font-size:21px}.count{font-size:19px}.pos-line{font-size:16px}.value{font-size:15px}}
</style></head><body>
<div class="header"><div class="title">BTC <span>MARTINGALE</span></div><div id="mode" class="badge demo">DEMO</div></div>
<div class="stats" id="stats"></div>
<div class="main"><div class="main-head"><div>5M WINDOW</div><div id="badge">WAITING</div></div><div class="body" id="content"></div></div>
<div class="logs" id="logs"></div>
<script src="/socket.io/socket.io.js"></script><script>
var socket=io(),state=null,logLines=[];
function q(id){return document.getElementById(id)}
function f2(n){return n==null?'--':Number(n).toFixed(2)}
function f3(n){return n==null?'--':Number(n).toFixed(3)}
function signed(n){return n>0?'+$'+f2(n):n<0?'-$'+f2(Math.abs(n)):'$0.00'}
function cls(n){return n>0?'positive':n<0?'negative':''}
function render(){
 var s=state;q('stats').innerHTML=[
  box('EQUITY','$'+f2(s?s.equity:0)),
  box('REALIZED','<span class="'+cls(s?s.realizedPnl:0)+'">'+signed(s?s.realizedPnl:0)+'</span>'),
  box('W/L','<span class="positive">'+(s?s.wins||0:0)+'W</span>/<span class="negative">'+(s?s.losses||0:0)+'L</span>'),
  box('NEXT STAKE','$'+f2(s?s.nextStakeIfStopped:50))
 ].join('');
 q('mode').className='badge '+(s&&!s.dryRun?'live':'demo');q('mode').textContent=s&&!s.dryRun?'LIVE':'DEMO';
 var leg=s&&s.currentLeg,p=s&&s.position,h='';
 h+='<div class="prices"><div><div class="label">UP PRICE</div><div class="price accent">'+f3(leg?leg.upMid:null)+'</div></div><div><div class="label">LEFT</div><div class="count">'+(leg?leg.secsLeft||0:0)+'s</div></div><div><div class="label">DOWN PRICE</div><div class="price warning">'+f3(leg?leg.downMid:null)+'</div></div></div>';
 h+='<div class="card position">';
 if(p){h+='<div class="pos-line">'+p.side.toUpperCase()+' '+p.label+' · '+p.shares+' SH @'+f2(p.entryPrice)+'</div><div class="sub">Cost $'+f2(p.cost)+' · Stop '+f2(p.stopLossPrice)+' · Mark '+f3(p.markPrice)+'<br>Float <span class="'+cls(p.unrealizedPnl)+'">'+signed(p.unrealizedPnl)+'</span> · Next MG $'+f2(s.nextStakeIfStopped)+'</div>'}
 else{h+='<div class="pos-line flat">NO OPEN POSITION</div><div class="sub">Entry zone '+f2(s?s.entryMin:0)+'–'+f2(s?s.entryMax:0)+' · Entries '+(s?s.elapsedSecond||0:0)+'/'+(s?s.entryStartSecond||0)+'–'+(s?s.entryEndSecond||0)+'s · Stop '+f2(s?s.stopLossPrice:0)+'<br>'+((s&&s.canEnter)?'Watching UP/DOWN':((s&&s.tradingAllowed===false)?'Stop-only period':'Martingale limit reached'))+'</div>'}
 h+='</div>';
 h+='<div class="card" style="margin-top:8px"><div class="label">STRATEGY</div><div class="sub">$'+f2(s?s.baseStakeUsd:0)+' base · '+f2(s?s.martingaleMultiplier:0)+'x martingale · entries '+(s?s.entryStartSecond||0)+'–'+(s?s.entryEndSecond||0)+'s · stop always active</div></div>';
 h+='<div class="history">';
 var hist=s?s.history||[]:[];
 for(var i=0;i<hist.length;i++){var x=hist[i];h+='<div class="row"><span>'+String(x.windowTs).slice(-5)+'</span><span>'+x.sides+'</span><span>'+x.trades+'T / '+x.martingales+'MG</span><span class="result '+(x.pnl>=0?'win':'loss')+'">'+(x.pnl>=0?'WIN':'LOSS')+' '+signed(x.pnl)+'</span></div>'}
 h+='</div>';q('content').innerHTML=h;
 q('badge').textContent=(leg&&leg.discovered?'LIVE WINDOW':'DISCOVERING')+' | '+signed(s?s.realizedPnl:0);
}
function box(label,value){return '<div class="box"><div class="label">'+label+'</div><div class="value">'+value+'</div></div>'}
function renderLogs(){var el=q('logs');if(!el)return;var bottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;el.innerHTML=logLines.slice(-180).map(function(line){
 var color='';if(line.indexOf('BUY')>=0)color='accent';else if(line.indexOf('STOP')>=0)color='negative';else if(line.indexOf('REARM')>=0)color='positive';else if(line.indexOf('RESOLVED')>=0)color='warning';
 return '<div class="'+color+'">'+line.replace(/</g,'&lt;')+'</div>'}).join('');if(bottom)el.scrollTop=el.scrollHeight}
socket.on('hedgeState:BTC-MARTINGALE',function(data){state=data;render()});
socket.on('log',function(line){logLines.push(line);if(logLines.length>500)logLines.shift();renderLogs()});
setInterval(render,1000);
setInterval(async function(){try{var response=await fetch('/api/hedge/status');var data=await response.json();if(data.engine){state=data.engine;render()}}catch(error){}},3000);
render();renderLogs();
</script></body></html>`;

app.get('/', (_, response) => { response.type('html').send(DASHBOARD); });

const emit = (event, data) => io.emit(event, data);
const slog = line => { console.log(line); io.emit('log', line); };
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) { console.error('PRIVATE_KEY env var missing'); process.exit(1); }

console.log('BTC Martingale Bot');
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard: http://0.0.0.0:${PORT}`);
  (async () => {
    const trader = new PolymarketTrader(privateKey);
    await trader.authenticate();
    engine = createEngine({
      label: 'BTC-MARTINGALE',
      windowType: '5m',
      startingCapital: CAPITAL,
      windowSeconds5: 300,
      baseStakeUsd: BASE_STAKE_USD,
      martingaleMultiplier: MARTINGALE_MULTIPLIER,
      maxMartingales: MAX_MARTINGALES,
      entryMin: ENTRY_MIN,
      entryMax: ENTRY_MAX,
      entryStartSecond: ENTRY_START_SECOND,
      entryEndSecond: ENTRY_END_SECOND,
      stopLossPrice: STOP_LOSS_PRICE,
      statsStatePath: process.env.STATS_STATE_PATH || path.join(__dirname, 'stats-martingale.json'),
      trader,
      dryRun: DRY_RUN,
      emit,
      slog,
    });
    engine.start();
  })().catch(error => {
    console.error('Bot init failed:', error.message);
    process.exit(1);
  });
});
