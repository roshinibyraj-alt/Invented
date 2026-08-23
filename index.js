'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const CAPITAL = Number(process.env.CAPITAL || 4000);
const BASE_STAKE_USD = Number(process.env.BASE_STAKE_USD || 500);
const PORT = process.env.PORT || 8080;

const LABEL = 'BTC-070';
const STATE_PATH = process.env.WALKTHROUGH_STATE_PATH || path.join(__dirname, 'stats-engine-070.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });

app.get('/healthz', (_, request) => request.sendStatus(200));
app.get('/api/hedge/status', (_, response) => {
  try {
    response.json({ dryRun: DRY_RUN, capital: CAPITAL, engine: engine ? engine.buildState() : null });
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message });
  }
});

const emit = (event, data) => io.emit(event, data);
const slog = line => { console.log(line); io.emit('log', line); };
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) { console.error('PRIVATE_KEY env var missing'); process.exit(1); }

let engine = null;

const ALLOWED_WINDOWS = [
  { start: 30, end: 60 },
  { start: 120, end: 150 },
];

const DASHBOARD = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC-070 Momentum</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#000;color:#fff;font-family:'Courier New',monospace;font-weight:bold;font-size:13px}
.header{padding:12px;background:#040404;border-bottom:3px solid #00ccff;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.title{font-size:20px}.title span{color:#00ccff}.badge{border:1px solid #333;border-radius:20px;padding:5px 11px}.demo{color:#ffcc00;background:#ffcc0018}.live{color:#ff5566;background:#ff556618}
.topstats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:9px}
.box,.card{background:#030303;border:1px solid #333;border-radius:7px;padding:9px}
.label{color:#888;font-size:9px;text-transform:uppercase}.value{font-size:17px;margin-top:3px;overflow-wrap:anywhere}
.positive{color:#00ff88}.negative{color:#ff4444}.accent{color:#00ccff}.warning{color:#ffcc00}.flat{color:#888}
.engine-panel{border:1px solid #222;border-radius:9px;overflow:hidden;background:#010101;margin:9px}
.panel-head{padding:10px;background:#060606;border-bottom:1px solid #222;display:flex;justify-content:space-between;font-size:14px}.panel-name span{color:#00ccff}
.body{padding:9px}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:8px}
.prices{display:grid;grid-template-columns:1fr auto 1fr;gap:7px;text-align:center;margin-bottom:8px}.price{font-size:28px}.count{font-size:24px;color:#ffcc00}
.position{min-height:90px}.pos-line{font-size:19px;margin-bottom:5px}.sub{font-size:13px;color:#ddd;line-height:1.45;overflow-wrap:anywhere}
.chart svg{display:block;width:100%;height:105px}.history{max-height:200px;overflow:auto;margin-top:8px}.row{display:flex;justify-content:space-between;gap:6px;padding:6px 0;border-top:1px solid #181818;font-size:11px;flex-wrap:wrap}
.result{padding:2px 5px;border-radius:4px}.win{color:#00ff88;background:#00ff8822}.loss{color:#ff4444;background:#ff444422}
.logs{height:220px;overflow:auto;padding:9px;border-top:1px solid #222;background:#000;font-size:12px;line-height:1.45;white-space:pre-wrap}
@media(max-width:600px){.topstats,.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.title{font-size:17px}.value{font-size:15px}.price{font-size:22px}.count{font-size:18px}.pos-line{font-size:16px}}
</style></head><body>
<div class="header"><div class="title">BTC <span>070 MOMENTUM</span></div><div id="mode" class="badge demo">DEMO</div></div>
<div class="topstats" id="topstats"></div><div class="engine-panel" id="engine"></div>
<script src="/socket.io/socket.io.js"></script><script>
var socket=io(),state=null,logs=[];
function q(id){return document.getElementById(id)}
function f2(n){return n==null?'--':Number(n).toFixed(2)}function f3(n){return n==null?'--':Number(n).toFixed(3)}
function signed(n){return n>0?'+$'+f2(n):n<0? '-$'+f2(Math.abs(n)):'$0.00'}function cls(n){return n>0?'positive':n<0?'negative':''}
function esc(x){return String(x==null?'':x).replace(/</g,'&lt;')}
function box(label,value){return '<div class="box"><div class="label">'+label+'</div><div class="value">'+value+'</div></div>'}
function chart(curve,start){if(!curve||curve.length<2)return '<div class="card chart"><div class="label">EQUITY CURVE</div><div class="sub flat">Collecting…</div></div>';
 var vals=curve.map(function(x){return Number(x.equity)||0});vals.push(Number(start)||0);var lo=Math.min.apply(null,vals),hi=Math.max.apply(null,vals),rg=(hi-lo)||1;
 function px(i){return (i/(curve.length-1)*600).toFixed(1)}function py(v){return (115-((v-lo)/rg*100)).toFixed(1)}
 var pts=curve.map(function(v,i){return px(i)+','+py(Number(v.equity)||0)}).join(' ');
 return '<div class="card chart"><div class="label">EQUITY CURVE</div><svg viewBox="0 0 600 125" preserveAspectRatio="none"><polyline points="'+pts+'" fill="none" stroke="#00ccff" stroke-width="3"></polyline></svg><div class="sub">Now '+f2(curve[curve.length-1].equity)+' · Start '+f2(start)+'</div></div>'}
function render(){
 if(!state)return;q('mode').textContent=state.dryRun?'DEMO':'LIVE';q('mode').className='badge '+(state.dryRun?'demo':'live');
 q('topstats').innerHTML=box('CAPITAL','$'+f2(state.equity))+box('REALIZED PNL','<span class="'+cls(state.realizedPnl)+'">'+signed(state.realizedPnl)+'</span>')+box('W/L','<span class="positive">'+(state.wins||0)+'W</span>/<span class="negative">'+(state.losses||0)+'L</span>')+box('FEES PAID','$'+f2(state.totalFeesPaid));
 var s=state,leg=s.currentLeg,positions=s.positions||[],h='';
 h+='<div class="panel-head"><div class="panel-name">'+esc(s.label)+' <span>0.70 MOMENTUM</span></div><div>'+(leg&&leg.discovered?'LIVE':'FINDING')+'</div></div><div class="body">';
 h+='<div class="prices"><div><div class="label">UP</div><div class="price accent">'+f3(leg?leg.upMid:null)+'</div></div><div><div class="label">LEFT</div><div class="count">'+(leg?leg.secsLeft||0:0)+'s</div></div><div><div class="label">DOWN</div><div class="price warning">'+f3(leg?leg.downMid:null)+'</div></div></div>';
 h+='<div class="card position">';
 if(positions.length){for(var pi=0;pi<positions.length;pi++){var p=positions[pi];
  h+='<div class="pos-line">'+esc(p.side.toUpperCase())+' B'+((p.block||0)+1)+' · '+esc(p.shares)+' SH @'+f2(p.entryPrice)+'</div><div class="sub">Cost $'+f2(p.cost)+' · Mark '+f3(p.markPrice)+' · Stop '+f2(p.stopLossPrice)+' · Float <span class="'+cls(p.unrealizedPnl)+'">'+signed(p.unrealizedPnl)+'</span></div>';}}
 else h+='<div class="pos-line flat">NO POSITION</div><div class="sub">$500 base · entries 30–60s & 120–150s · '+(s.tradingAllowed?'Watching':'Outside window')+' · '+((s.elapsedSecond!=null)?s.elapsedSecond+'s':'')+'</div>';
 h+='</div>';
 h+='<div class="card" style="margin-top:8px"><div class="label">STRATEGY</div><div class="sub">$500 flat · no martingale · entry @0.70 walk-through · stop @0.45 · windows 30–60s & 120–150s only</div></div>';
 h+=chart(s.equityCurve||[],s.startingCapital||0);
 h+='<div class="history">';var hist=s.history||[];
 for(var i=0;i<hist.length;i++){var x=hist[i];h+='<div class="row"><span>'+esc(String(x.windowTs).slice(-5))+'</span><span>'+esc(x.sides)+'</span><span>'+x.trades+'T</span><span class="result '+(x.pnl>=0?'win':'loss')+'">'+signed(x.pnl)+'</span></div>'}
 h+='</div></div>';
 q('engine').innerHTML=h;
 var el=q('logs');if(!el)return;var bottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
 el.innerHTML=logs.slice(-160).map(function(line){var c='';if(line.indexOf('BUY')>=0)c='accent';else if(line.indexOf('STOP')>=0)c='negative';else if(line.indexOf('RESOLVED')>=0||line.indexOf('won')>=0)c='positive';return '<div class="'+c+'">'+esc(line)+'</div>'}).join('');
 if(bottom)el.scrollTop=el.scrollHeight;
}
socket.on('hedgeState:${LABEL}',function(data){state=data;render()});
socket.on('log',function(line){logs.push(line);if(logs.length>500)logs.shift();render()});
setInterval(render,1000);
(async function(){try{var r=await fetch('/api/hedge/status');var d=await r.json();state=d.engine;render()}catch(_){}})();
render();
</script><div class="logs" id="logs"></div></body></html>`;

app.get('/', (_, response) => response.type('html').send(DASHBOARD));

console.log('BTC-070 Single Engine Bot');
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard: http://0.0.0.0:${PORT}`);
  (async () => {
    const trader = new PolymarketTrader(privateKey);
    await trader.authenticate();
    engine = createEngine({
      label: LABEL,
      strategy: 'walkthrough',
      startingCapital: CAPITAL,
      baseStakeUsd: BASE_STAKE_USD,
      windowType: '5m',
      windowSeconds5: 300,
      allowedWindows: ALLOWED_WINDOWS,
      martingaleMultiplier: 1,
      maxMartingales: 0,
      entryPrice: Number(process.env.ENTRY_PRICE || 0.70),
      stopLossPrice: Number(process.env.STOP_LOSS_PRICE || 0.45),
      feeTheta: 0.07,
      trader,
      dryRun: DRY_RUN,
      statsStatePath: STATE_PATH,
      emit,
      slog,
    });
    engine.start();
  })().catch(error => {
    console.error('Bot init failed:', error.message);
    process.exit(1);
  });
});
