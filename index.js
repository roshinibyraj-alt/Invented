'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PolymarketTrader = require('./polymarket-trader');
const { createCapitalLedger } = require('./capital-ledger');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const CAPITAL = Number(process.env.CAPITAL || 4000);
const BASE_STAKE_USD = Number(process.env.BASE_STAKE_USD || 50);
const PORT = process.env.PORT || 8080;

const WALK_LABEL = 'BTC-070';
const LIMIT_LABEL = 'BTC-030';
const BASE_STATE_PATH = process.env.STATS_STATE_PATH || path.join(__dirname, 'stats-martingale.json');
const SHARED_STATE_PATH = process.env.SHARED_CAPITAL_STATE_PATH || BASE_STATE_PATH;
const WALK_STATE_PATH = process.env.WALKTHROUGH_STATE_PATH || path.join(__dirname, 'stats-engine-070.json');
const LIMIT_STATE_PATH = process.env.LIMIT_STATE_PATH || path.join(__dirname, 'stats-engine-030.json');

function migrateLegacyEngineState() {
  try {
    if (fs.existsSync(WALK_STATE_PATH) || !fs.existsSync(BASE_STATE_PATH)) return;
    const old = JSON.parse(fs.readFileSync(BASE_STATE_PATH, 'utf8'));
    const next = {
      realizedPnl: old.realizedPnl || 0,
      wins: old.wins || 0,
      losses: old.losses || 0,
      history: Array.isArray(old.history) ? old.history : [],
      equityCurve: Array.isArray(old.equityCurve) ? old.equityCurve : [],
      totalFeesPaid: old.totalFeesPaid || 0,
      martingaleLevel: old.martingaleLevel || 0,
      lastTradeWindowTs: old.lastTradeWindowTs || null,
    };
    fs.writeFileSync(WALK_STATE_PATH, JSON.stringify(next));
  } catch (_) {}
}

migrateLegacyEngineState();
const sharedCapital = createCapitalLedger({
  path: SHARED_STATE_PATH,
  legacyPath: path.join(__dirname, 'stats-legacy-capital.json'),
  startingCapital: CAPITAL,
});

let engines = {};
let trader = null;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });

app.get('/healthz', (_, request) => request.sendStatus(200));
app.get('/api/hedge/status', (_, response) => {
  try {
    const states = Object.fromEntries(Object.entries(engines).map(([key, engine]) => [key, engine.buildState()]));
    response.json({ dryRun: DRY_RUN, capital: sharedCapital.snapshot(), engines: states });
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message });
  }
});
for (const route of ['pause', 'resume']) {
  app.post(`/api/hedge/${route}`, (_, response) => {
    try {
      Object.values(engines).forEach(engine => engine[route === 'pause' ? 'pauseTrading' : 'resumeTrading']());
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message });
    }
  });
}

const emit = (event, data) => io.emit(event, data);
const slog = line => { console.log(line); io.emit('log', line); };
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) { console.error('PRIVATE_KEY env var missing'); process.exit(1); }

const DASHBOARD = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC Dual Engines</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#000;color:#fff;font-family:'Courier New',monospace;font-weight:bold;font-size:13px}
.header{padding:12px;background:#040404;border-bottom:3px solid #00ccff;display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}
.title{font-size:20px}.title span{color:#00ccff}.badge{border:1px solid #333;border-radius:20px;padding:5px 11px}.demo{color:#ffcc00;background:#ffcc0018}.live{color:#ff5566;background:#ff556618}
.topstats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:9px}.box,.card{background:#030303;border:1px solid #333;border-radius:7px;padding:9px}
.label{color:#888;font-size:9px;text-transform:uppercase}.value{font-size:17px;margin-top:3px;overflow-wrap:anywhere}.positive{color:#00ff88}.negative{color:#ff4444}.accent{color:#00ccff}.warning{color:#ffcc00}.flat{color:#888}
.engines{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;padding:0 9px 9px}
.engine-panel{border:1px solid #222;border-radius:9px;overflow:hidden;background:#010101;min-width:0}
.panel-head{padding:10px;background:#060606;border-bottom:1px solid #222;display:flex;justify-content:space-between;gap:8px;font-size:13px}.panel-name span{color:#00ccff}
.body{padding:9px;min-width:0}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:8px}
.prices{display:grid;grid-template-columns:1fr auto 1fr;gap:7px;text-align:center;margin-bottom:8px}.price{font-size:24px}.count{font-size:21px;color:#ffcc00}
.position{min-height:96px}.pos-line{font-size:18px;margin-bottom:5px}.sub{font-size:13px;color:#ddd;line-height:1.45;overflow-wrap:anywhere}
.chart svg{display:block;width:100%;height:105px}.history{max-height:180px;overflow:auto;margin-top:8px}.row{display:flex;justify-content:space-between;gap:6px;padding:6px 0;border-top:1px solid #181818;font-size:11px;flex-wrap:wrap}
.result{padding:2px 5px;border-radius:4px}.win{color:#00ff88;background:#00ff8822}.loss{color:#ff4444;background:#ff444422}
.logs{height:190px;overflow:auto;padding:9px;border-top:1px solid #222;background:#000;font-size:12px;line-height:1.45;white-space:pre-wrap}
@media(max-width:950px){.engines{grid-template-columns:1fr}}@media(max-width:600px){.topstats,.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.title{font-size:17px}.value{font-size:15px}.price{font-size:21px}.count{font-size:19px}.pos-line{font-size:16px}}
</style></head><body>
<div class="header"><div class="title">BTC <span>DUAL ENGINES</span></div><div id="mode" class="badge demo">DEMO</div></div>
<div class="topstats" id="topstats"></div><div class="engines" id="engines"></div>
<script src="/socket.io/socket.io.js"></script><script>
var socket=io(),states={},logStore={};
function q(id){return document.getElementById(id)}
function f2(n){return n==null?'--':Number(n).toFixed(2)}function f3(n){return n==null?'--':Number(n).toFixed(3)}
function signed(n){return n>0?'+$'+f2(n):n<0?'-$'+f2(Math.abs(n)):'$0.00'}function cls(n){return n>0?'positive':n<0?'negative':''}
function esc(x){return String(x==null?'':x).replace(/</g,'&lt;')}
function box(label,value){return '<div class="box"><div class="label">'+label+'</div><div class="value">'+value+'</div></div>'}
function chart(curve,start){if(!curve||curve.length<2)return '<div class="card chart"><div class="label">EQUITY CURVE</div><div class="sub flat">Collecting…</div></div>';
 var vals=curve.map(function(x){return Number(x.equity)||0});vals.push(Number(start)||0);var lo=Math.min.apply(null,vals),hi=Math.max.apply(null,vals),rg=(hi-lo)||1;
 function px(i){return (i/(curve.length-1)*600).toFixed(1)}function py(v){return (115-((v-lo)/rg*100)).toFixed(1)}
 var pts=curve.map(function(v,i){return px(i)+','+py(Number(v.equity)||0)}).join(' ');
 return '<div class="card chart"><div class="label">EQUITY CURVE</div><svg viewBox="0 0 600 125" preserveAspectRatio=\"none\"><polyline points=\"'+pts+'\" fill=\"none\" stroke=\"#00ccff\" stroke-width=\"3\"></polyline></svg><div class=\"sub\">Now '+f2(curve[curve.length-1].equity)+' · Start '+f2(start)+'</div></div>'}
function panelHTML(s,key){
 var leg=s&&s.currentLeg,p=s&&s.position,h='';
 h+='<div class="engine-panel"><div class="panel-head"><div class="panel-name">'+esc(s?s.label:key)+' <span>'+esc(s?(s.strategy==='limit-pair'?'0.30 PAIR':'0.70 MOMENTUM'):'')+'</span></div><div>'+(leg&&leg.discovered?'LIVE':'FINDING')+'</div></div><div class="body">';
 h+='<div class="stats">'+box('ENGINE EQUITY','$'+f2(s?s.equity:0))+box('ENGINE PNL','<span class="'+cls(s?s.realizedPnl:0)+'">'+signed(s?s.realizedPnl:0)+'</span>')+box('W/L','<span class="positive">'+(s?s.wins||0:0)+'W</span>/<span class="negative">'+(s?s.losses||0:0)+'L</span>')+box('NEXT STAKE','$'+f2(s?s.nextStakeIfStopped:0))+'</div>';
 h+='<div class="prices"><div><div class="label">UP</div><div class="price accent">'+f3(leg?leg.upMid:null)+'</div></div><div><div class="label">LEFT</div><div class="count">'+(leg?leg.secsLeft||0:0)+'s</div></div><div><div class="label">DOWN</div><div class="price warning">'+f3(leg?leg.downMid:null)+'</div></div></div>';
 h+='<div class="card position">';
 if(p)h+='<div class="pos-line">'+esc(p.side.toUpperCase())+' '+esc(p.label)+' · '+esc(p.shares)+' SH @'+f2(p.entryPrice)+'</div><div class="sub">Cost $'+f2(p.cost)+' · Mark '+f3(p.markPrice)+(p.stopLossPrice?' · Stop '+f2(p.stopLossPrice):' · No stop')+'<br>Float <span class="'+cls(p.unrealizedPnl)+'">'+signed(p.unrealizedPnl)+'</span> · Next $'+f2(s.nextStakeIfStopped)+'</div>';
 else if(s&&s.pendingOrders&&s.pendingOrders.length)h+='<div class="pos-line flat">TWIN LIMITS WORKING</div><div class="sub">'+s.pendingOrders.map(function(o){return esc(o.side.toUpperCase())+' '+esc(o.shares)+' @'+f2(o.price)}).join(' · ')+'</div>';
 else h+='<div class="pos-line flat">NO POSITION</div><div class="sub">Entry '+f2(s?s.entryPrice:0)+' · Time '+(s?s.elapsedSecond||0:0)+'/'+(s?s.entryStartSecond:0)+'–'+(s?s.entryEndSecond:0)+'s · '+(s&&s.tradingAllowed?'Watching':'Outside window')+'</div>';
 h+='</div>';
 h+='<div class="card" style="margin-top:8px"><div class="label">STRATEGY</div><div class="sub">$'+f2(s?s.baseStakeUsd:0)+' base · '+f2(s?s.martingaleMultiplier:0)+'x · max MG'+(s?s.maxMartingales:0)+' · entries '+(s?s.entryStartSecond:0)+'–'+(s?s.entryEndSecond:0)+'s · '+(s&&s.strategy==='limit-pair'?'0.30 pair, cancel loser, no stop':'0.70 walk-through, stop active')+'</div></div>';
 h+=chart(s?s.equityCurve||[]:[],s?s.startingCapital:0);
 h+='<div class="history">';var hist=s?s.history||[]:[];
 for(var i=0;i<hist.length;i++){var x=hist[i];h+='<div class="row"><span>'+esc(String(x.windowTs).slice(-5))+'</span><span>'+esc(x.sides)+'</span><span>'+x.trades+'T/MG'+x.martingales+'</span><span class="result '+(x.pnl>=0?'win':'loss')+'">'+signed(x.pnl)+'</span></div>'}
 h+='</div></div><div class="logs" id="logs-'+key+'"></div></div>';return h;
}
function renderLogs(key){var el=q('logs-'+key);if(!el)return;var lines=logStore[key]||[],bottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
 el.innerHTML=lines.slice(-140).map(function(line){var c='';if(line.indexOf('BUY')>=0)c='accent';else if(line.indexOf('STOP')>=0)c='negative';else if(line.indexOf('CANCEL')>=0)c='warning';else if(line.indexOf('RESOLVED')>=0||line.indexOf('won')>=0)c='positive';return '<div class="'+c+'">'+esc(line)+'</div>'}).join('');
 if(bottom)el.scrollTop=el.scrollHeight}
function render(){
 var list=[states['${WALK_LABEL}'],states['${LIMIT_LABEL}']];
 q('engines').innerHTML=list.map(function(s,i){return panelHTML(s,i?'limit':'walk')}).join('');
 Object.keys(logStore).forEach(renderLogs);
 var cap=list[0],openFloat=list.reduce(function(sum,s){return sum+(s?s.unrealizedPnl||0:0)},0),realized=list.reduce(function(sum,s){return sum+(s?s.realizedPnl||0:0)},0);
 var live=list.some(function(s){return s&&!s.dryRun});q('mode').className='badge '+(live?'live':'demo');q('mode').textContent=live?'LIVE':'DEMO';
 q('topstats').innerHTML=[box('SHARED CAPITAL','$'+f2(cap?cap.bankroll:0)),box('COMBINED REALIZED','<span class="'+cls(realized)+'">'+signed(realized)+'</span>'),box('OPEN FLOAT','<span class="'+cls(openFloat)+'">'+signed(openFloat)+'</span>'),box('COMBINED EQUITY','$'+f2(cap?cap.equity:0))].join('');
}
['${WALK_LABEL}','${LIMIT_LABEL}'].forEach(function(label){logStore[label]=[];socket.on('hedgeState:'+label,function(data){states[label]=data;render()})});
socket.on('log',function(line){var key=line.indexOf('[BTC-030]')===0?'${LIMIT_LABEL}':'${WALK_LABEL}';if(!logStore[key])logStore[key]=[];logStore[key].push(line);if(logStore[key].length>500)logStore[key].shift();renderLogs(key)});
setInterval(render,1000);setInterval(async function(){try{var r=await fetch('/api/hedge/status');var d=await r.json();states['${WALK_LABEL}']=d.engines['${WALK_LABEL}'];states['${LIMIT_LABEL}']=d.engines['${LIMIT_LABEL}'];render()}catch(_){}},3000);render();
</script></body></html>`;

app.get('/', (_, response) => response.type('html').send(DASHBOARD));
console.log('BTC Dual Engine Bot');
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard: http://0.0.0.0:${PORT}`);
  (async () => {
    trader = new PolymarketTrader(privateKey);
    await trader.authenticate();
    const common = {
      startingCapital: CAPITAL, baseStakeUsd: BASE_STAKE_USD, windowType: '5m', windowSeconds5: 300,
      entryStartSecond: Number(process.env.ENTRY_START_SECOND || 30),
      entryEndSecond: Number(process.env.ENTRY_END_SECOND || 270),
      feeTheta: 0.07, trader, dryRun: DRY_RUN, emit, slog,
    };
    engines = {
      [WALK_LABEL]: createEngine({
        ...common, label: WALK_LABEL, strategy: 'walkthrough', sharedCapital,
        martingaleMultiplier: Number(process.env.MARTINGALE_MULTIPLIER || 2.1),
        maxMartingales: Number(process.env.MAX_MARTINGALES || 5),
        entryPrice: Number(process.env.ENTRY_PRICE || 0.70),
        stopLossPrice: Number(process.env.STOP_LOSS_PRICE || 0.45),
        statsStatePath: WALK_STATE_PATH,
      }),
      [LIMIT_LABEL]: createEngine({
        ...common, label: LIMIT_LABEL, strategy: 'limit-pair', sharedCapital,
        baseStakeUsd: Number(process.env.LIMIT_BASE_STAKE_USD || BASE_STAKE_USD),
        martingaleMultiplier: Number(process.env.LIMIT_MARTINGALE_MULTIPLIER || 1.5),
        maxMartingales: Number(process.env.LIMIT_MAX_MARTINGALES || 7),
        entryPrice: Number(process.env.LIMIT_ENTRY_PRICE || 0.30),
        stopLossPrice: 0,
        statsStatePath: LIMIT_STATE_PATH,
      }),
    };
    Object.values(engines).forEach(engine => engine.start());
  })().catch(error => {
    console.error('Bot init failed:', error.message);
    process.exit(1);
  });
});
