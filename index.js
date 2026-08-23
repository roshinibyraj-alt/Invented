'use strict';
const path=require('path'),fs=require('fs'),express=require('express'),http=require('http');
const {Server}=require('socket.io');
const PolymarketTrader=require('./polymarket-trader');

const DRY_RUN=(process.env.DRY_RUN||'true').toLowerCase()==='true';
const CAPITAL=Number(process.env.CAPITAL||4000);
const BASE_STAKE=Number(process.env.BASE_STAKE_USD||100);
const PORT=process.env.PORT||8080;
const CLOB='https://clob.polymarket.com';
const TRADE_START=60,TRADE_END=240;
const EDGE_THRESHOLD=0.10;

const app=express(),server=http.createServer(app),io=new Server(server,{pingInterval:2000,pingTimeout:5000});
app.get('/healthz',(_,r)=>r.sendStatus(200));
const privateKey=process.env.PRIVATE_KEY;if(!privateKey){console.error('PRIVATE_KEY missing');process.exit(1);}

let trader=null;
const STATE_FILE=path.join(__dirname,'convergence-state.json');
let stats={realizedPnl:0,wins:0,losses:0,totalFees:0,equityCurve:[],history:[],logs:[]};

function loadState(){
  try{
    if(fs.existsSync(STATE_FILE)){
      const saved=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
      stats.realizedPnl=saved.realizedPnl||0;
      stats.wins=saved.wins||0;
      stats.losses=saved.losses||0;
      stats.totalFees=saved.totalFees||0;
      stats.equityCurve=saved.equityCurve||[];
      stats.history=saved.history||[];
    }
  }catch(_){}
}
function saveState(){
  try{fs.writeFileSync(STATE_FILE,JSON.stringify({realizedPnl:stats.realizedPnl,wins:stats.wins,losses:stats.losses,totalFees:stats.totalFees,equityCurve:stats.equityCurve.slice(-5000),history:stats.history.slice(-200)}))}catch(_){}
}
loadState();

// Per-window state
let leg=null,btcOpen=null,btcNow=null,upMid=null,downMid=null,fairUp=null;
let positions=[],firedSides=new Set(),lastDiscovery=0,lastBtc=0,lastClob=0,lastEquity=0;
let pendingResolutions=[];
let flipCount=0,oppositeEdgeTicks=0;
let resolvedIds=new Set();

async function j(url){const r=await fetch(url);if(!r.ok)throw new Error(r.status+' '+url);return r.json();}
function r2(v){return Math.round(v*100)/100}
function money(v){return(v>0?'+$':v<0?'-$':'$')+Math.abs(v).toFixed(2)}
function slog(line){console.log(line);stats.logs.push(line);if(stats.logs.length>300)stats.logs.shift();io.emit('log',line)}
async function btcPrice(){try{const d=await j('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');return parseFloat(d.price)}catch(_){return null}}
async function btcOpenPrice(ts){try{const k=await j(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime=${ts*1000}&endTime=${ts*1000+1000}&limit=1`);return k.length?parseFloat(k[0][1]):null}catch(_){return null}}

async function discoverLeg(ts){
  try{
    const [e]=await j('https://gamma-api.polymarket.com/events?slug=btc-updown-5m-'+ts);
    if(!e)return null;
    const m=e.markets[0],tokens=m.clobTokenIds?JSON.parse(m.clobTokenIds):[];
    return{ts,slug:'btc-updown-5m-'+ts,upToken:tokens[0],downToken:tokens[1],discovered:true,resolved:false,winner:null};
  }catch(_){return null}
}

async function fetchClobPrices(){
  if(!leg?.discovered||!leg.upToken)return;
  try{
    const[bu,bd]=await Promise.all([
      j(CLOB+'/midpoint?token_id='+leg.upToken).catch(()=>null),
      j(CLOB+'/midpoint?token_id='+leg.downToken).catch(()=>null),
    ]);
    if(bu?.mid)upMid=parseFloat(bu.mid);
    if(bd?.mid)downMid=parseFloat(bd.mid);
  }catch(_){}
}

function fairProbability(){
  if(btcNow==null||btcOpen==null||!leg)return null;
  const elapsed=Math.floor(Date.now()/1000)-leg.windowTs;
  const secsLeft=Math.max(1,300-elapsed);
  const diff=btcNow-btcOpen;
  const sigma=Math.sqrt(secsLeft)*3;
  return 1/(1+Math.exp(-diff/sigma));
}

function findEdge(){
  if(fairUp==null||upMid==null||downMid==null)return null;
  const fairDown=1-fairUp;
  const upDominant=upMid>0.75;
  const downDominant=downMid>0.75;
  if(upMid<(fairUp*(1-EDGE_THRESHOLD))&&!firedSides.has('up')&&!downDominant)return{side:'up',price:upMid};
  if(downMid<(fairDown*(1-EDGE_THRESHOLD))&&!firedSides.has('down')&&!upDominant)return{side:'down',price:downMid};
  return null;
}

const WINNER_THRESHOLD=0.90;

function checkFlip(){
  if(flipCount>=1||fairUp==null)return;
  const hasUp=positions.some(p=>p.side==='up');
  const hasDown=positions.some(p=>p.side==='down');
  if(!hasUp&&!hasDown){oppositeEdgeTicks=0;return;}
  const oppositeSide=hasUp?'down':'up';
  const oppPrice=oppositeSide==='down'?downMid:upMid;
  const oppFair=oppositeSide==='down'?(1-fairUp):fairUp;
  if(oppPrice!=null&&oppPrice<(oppFair*(1-EDGE_THRESHOLD))){oppositeEdgeTicks++}else{oppositeEdgeTicks=0;return}
  if(oppositeEdgeTicks<3)return;
  slog(`🔄 FLIP SIGNAL — ${oppositeSide.toUpperCase()} edge confirmed (${oppositeEdgeTicks} ticks)`);
  const toClose=positions.find(p=>p.side!==oppositeSide);
  if(toClose){
    const exitMid=toClose.side==='up'?upMid:downMid;
    const pnl=r2(toClose.shares*(exitMid||toClose.entryPrice)-toClose.cost);
    stats.realizedPnl=r2(stats.realizedPnl+pnl);
    if(pnl>0)stats.wins++;else stats.losses++;
    positions=positions.filter(p=>p.side!==toClose.side||p!==toClose);
    slog(`🔄 FLIP CLOSE ${toClose.side.toUpperCase()} @${(exitMid||toClose.entryPrice).toFixed(2)} — PnL ${money(pnl)}`);
  }
  firedSides.add(oppositeSide);flipCount++;
  fire(oppositeSide,oppPrice);
}

function fastResolve(){
  if(!leg?.discovered||!positions.length)return;
  const elapsed=leg.elapsedSecond();
  if(elapsed<295)return;
  const upWinning=upMid!=null&&upMid>WINNER_THRESHOLD;
  const downWinning=downMid!=null&&downMid>WINNER_THRESHOLD;
  if(!upWinning&&!downWinning)return;
  const winner=upWinning&&downWinning?((upMid>downMid)?'up':'down'):upWinning?'up':downWinning?'down':null;
  if(!winner)return;
  if(upWinning&&downWinning)slog(`⚠️ both mids >0.90 (${upMid}/${downMid}) — picking ${winner.toUpperCase()}`);
  slog(`⚡ FAST RESOLVE triggered — ${winner.toUpperCase()} CLOB ${(winner==='up'?upMid:downMid).toFixed(2)}>0.90`);
  for(const pos of [...positions]){
    settleWith(pos,winner);
    positions=positions.filter(p=>p.id!==pos.id);
  }
}

async function fire(side,clobPrice){
  if(firedSides.has(side))return;
  firedSides.add(side);
  const token=side==='up'?leg.upToken:leg.downToken;
  slog(`🎯 ${side.toUpperCase()} EDGE — CLOB ${clobPrice.toFixed(3)} vs fair ${fairUp!=null?(side==='up'?fairUp.toFixed(3):(1-fairUp).toFixed(3)):'--'}`);
  try{
    let pos;
    if(DRY_RUN){
      const shares=Math.floor(BASE_STAKE/clobPrice*100)/100;
      pos={side,shares,entryPrice:clobPrice,cost:r2(shares*clobPrice),openedAt:Date.now()};
      slog(`✅ DEMO ${side.toUpperCase()} BUY ${shares}sh @${clobPrice.toFixed(2)} | cost $${pos.cost}`);
    }else{
      const order=await trader.placeFokBuy(token,BASE_STAKE);
      if(!order.isFilled){slog(`❌ ${side.toUpperCase()} FOK rejected`);firedSides.delete(side);return;}
      const fp=parseFloat(order.avgPrice)||clobPrice;
      const rawShares=parseFloat(order.raw?.takingAmount||order.raw?.size_matched||'0');
      const sh=rawShares>0?r2(rawShares):Math.floor(BASE_STAKE/fp*100)/100;
      pos={side,shares:sh,entryPrice:fp,cost:BASE_STAKE,openedAt:Date.now()};
      slog(`✅ LIVE ${side.toUpperCase()} BUY ${sh}sh @${fp}`);
    }
    positions.push(pos);
  }catch(e){slog(`❌ buy error: ${e.message}`);firedSides.delete(side);}
}

function settleWith(pos,winner){
  if(!pos)return;
  if(resolvedIds.has(pos.id))return;
  resolvedIds.add(pos.id);
  const won=winner===pos.side,payout=won?pos.shares:0,pnl=r2(payout-pos.cost);
  stats.realizedPnl=r2(stats.realizedPnl+pnl);
  if(pnl>0)stats.wins++;else stats.losses++;
  slog(`🏁 ${pos.side.toUpperCase()} ${won?'WIN':'LOSS'} — PnL ${money(pnl)}`);
  stats.history.unshift({ts:Date.now(),winner:won?'WIN':'LOSS',side:pos.side.toUpperCase(),pnl});
  if(stats.history.length>200)stats.history.length=200;
  saveState();
}

async function tryResolve(oldLeg){
  try{
    const[e]=await j('https://gamma-api.polymarket.com/events?slug='+oldLeg.slug);
    if(e?.markets?.[0]?.closed){
      oldLeg.winner=JSON.parse(e.markets[0].outcomePrices||'[0,0]');
      oldLeg.resolved=true;return true;
    }
  }catch(_){}
  return false;
}

function resetWindow(ts){
  leg={windowTs:ts,elapsedSecond:()=>Math.floor(Date.now()/1000)-ts,discovered:false};
  btcOpen=null;positions=[];firedSides.clear();lastDiscovery=0;flipCount=0;oppositeEdgeTicks=0;resolvedIds.clear();
  slog(`🆕 window t=${ts}`);
}

async function loop(){
  while(true){
    try{
      const nowSec=Math.floor(Date.now()/1000),ts=Math.floor(nowSec/300)*300;
      if(!leg||leg.windowTs!==ts){
        if(leg&&leg.discovered){pendingResolutions.push({leg:{...leg},positions:[...positions]});slog(`⏳ resolution pending ${leg.slug}`)}
        resetWindow(ts);
      }
      for(let i=pendingResolutions.length-1;i>=0;i--){
        const pr=pendingResolutions[i];
        if(await tryResolve(pr.leg)){
          pr.positions.forEach(p=>settleWith(p,pr.leg.winner[0]>=0.5?'up':'down'));
          pendingResolutions.splice(i,1);
        }
      }
      if(!leg.discovered&&nowSec-lastDiscovery>=500){
        lastDiscovery=nowSec;
        const l=await discoverLeg(ts);
        if(l){Object.assign(leg,l);slog(`🎯 discovered ${l.slug}`)}
      }
      if(Date.now()-lastBtc>=200){lastBtc=Date.now();const p=await btcPrice();if(p!=null)btcNow=p;if(btcOpen==null&&leg.discovered)btcOpen=await btcOpenPrice(ts)}
      if(Date.now()-lastClob>=200){lastClob=Date.now();await fetchClobPrices()}
      fairUp=fairProbability();
      const elapsed=leg?.elapsedSecond?.()||0;
      fastResolve();
      checkFlip();
      if(leg?.discovered&&elapsed>=TRADE_START&&elapsed<TRADE_END&&positions.length<2&&btcOpen!=null){
        const edge=findEdge();
        if(edge&&!firedSides.has(edge.side))await fire(edge.side,edge.price);
      }
      if(nowSec-lastEquity>=1){
        lastEquity=nowSec;
        let unrealized=0;
        positions.forEach(p=>{unrealized+=p.shares*(p.side==='up'?upMid||p.entryPrice:downMid||p.entryPrice)-p.cost});
        stats.equityCurve.push({t:Date.now(),equity:r2(CAPITAL+stats.realizedPnl+unrealized)});
        if(stats.equityCurve.length>20000)stats.equityCurve.shift();
        if(stats.equityCurve.length%30===0)saveState();
      }
      emitState();
    }catch(e){slog(`⚠️ ${e.message}`)}
    await new Promise(r=>setTimeout(r,200));
  }
}

function buildState(){
  const elapsed=leg?.elapsedSecond?.()||0,secsLeft=Math.max(0,300-elapsed);
  const unrealized=positions.reduce((sum,p)=>sum+(p.shares*((p.side==='up'?upMid:downMid)||p.entryPrice)-p.cost),0);
  return{dryRun:DRY_RUN,capital:CAPITAL,baseStake:BASE_STAKE,...{realizedPnl:stats.realizedPnl,wins:stats.wins,losses:stats.losses,totalFees:r2(stats.totalFees)},
    equityCurve:stats.equityCurve,history:stats.history,
    btcPrice:btcNow,btcOpen,upMid,downMid,fairUp,edgeThreshold:EDGE_THRESHOLD,
    positions,secsLeft,elapsed,discovered:!!leg?.discovered,slug:leg?.slug||null,
    winRate:(stats.wins+stats.losses)?r2(stats.wins/(stats.wins+stats.losses)*100):null};
}
function emitState(){io.emit('state',buildState())}
app.get('/api/status',(_,r)=>r.json(buildState()));

const HTML=`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC Convergence Hunter</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#000;color:#fff;font-family:'Courier New',monospace;font-weight:bold;font-size:13px;padding:9px}
.h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.title{font-size:19px}.title span{color:#00ccff}.badge{padding:4px 10px;border-radius:14px;border:1px solid #333;font-size:11px}.demo{color:#ffcc00;background:#ffcc0018}.live{color:#ff5566;background:#ff556618}
.timerbar{text-align:center;padding:12px;background:#050505;border:2px solid #222;border-radius:8px;margin-bottom:8px}.timerval{font-size:44px;color:#00ccff;font-variant-numeric:tabular-nums;line-height:1}.timerlbl{font-size:10px;color:#777;text-transform:uppercase;letter-spacing:2px;margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px}.box{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:6px;padding:8px}.lb{font-size:9px;color:#777;text-transform:uppercase}.val{font-size:17px;margin-top:3px}
.green{color:#00ff88}.red{color:#ff4444}.acc{color:#00ccff}.warn{color:#ffcc00}
.card{background:#080808;border:1px solid #1e1e1e;border-radius:7px;padding:10px;margin-bottom:8px}
.prices{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;text-align:center;padding:8px 0}.price{font-size:26px}.plabel{font-size:9px;color:#777;text-transform:uppercase;letter-spacing:1px}
.poscard{border-left:3px solid #333;padding-left:10px;margin-bottom:6px}.posline{font-size:18px}.posdetail{font-size:12px;color:#aaa;margin-top:4px;line-height:1.5}
.stratinfo{font-size:11px;color:#666;line-height:1.7;margin-top:8px;border-top:1px solid #1a1a1a;padding-top:8px}
#chart svg{width:100%;height:95px}#hist div,#log div{padding:5px 0;border-bottom:1px solid #151515;font-size:11px}
#hist{max-height:180px;overflow-y:auto}#log{max-height:250px;overflow-y:auto;background:#000;padding:8px;border:1px solid #1a1a1a;border-radius:5px;line-height:1.55;white-space:pre-wrap}
.sub{font-size:11px;color:#999;text-align:center;margin-top:6px}
@media(max-width:600px){.grid{grid-template-columns:repeat(2,1fr)}.val{font-size:14px}.price{font-size:20px}.timerval{font-size:36px}.prices{grid-template-columns:repeat(3,1fr)}}</style></head><body>
<div class="h"><div class="title">BTC <span>CONVERGENCE HUNTER</span></div><div id="mode" class="badge demo">DEMO</div></div>
<div class="timerbar"><div class="timerval" id="timer">--</div><div class="timerlbl">SECONDS LEFT · 5M WINDOW</div></div>
<div class="grid" id="top"></div>
<div class="card"><div class="prices">
<div><div class="plabel">UP</div><div class="price acc" id="upP">--</div></div>
<div><div class="plabel">FAIR UP</div><div class="price" style="color:#888" id="fairP">--</div></div>
<div><div class="plabel">BTC</div><div class="price" style="color:#ffcc00" id="btcP">--</div></div>
<div><div class="plabel">BEAT</div><div class="price" style="color:#888" id="beatP">--</div></div>
<div><div class="plabel">DOWN</div><div class="price warn" id="dnP">--</div></div>
</div></div>
<div class="card"><div style="font-size:9px;color:#777;text-transform:uppercase;margin-bottom:7px">POSITIONS</div><div id="posarea"></div>
<div class="stratinfo">\$100 flat per side · max 2 (UP+DOWN) · trade window 60–240s<br>Fires when CLOB mid deviates >\${(10)}% from fair probability · holds to resolution</div></div>
<div class="card"><div style="font-size:9px;color:#777;text-transform:uppercase;margin-bottom:5px">EQUITY CURVE</div><div id="chart"><svg viewBox="0 0 600 95" preserveAspectRatio="none"><polyline id="eqline" fill="none" stroke="#00ccff" stroke-width="2.5"/></svg></div></div>
<div class="card"><div style="font-size:9px;color:#777;text-transform:uppercase;margin-bottom:5px">TRADE HISTORY</div><div id="hist"></div></div>
<div class="card"><div style="font-size:9px;color:#777;text-transform:uppercase;margin-bottom:5px">SERVER LOGS</div><div id="log"></div></div>
<script src="/socket.io/socket.io.js"></script><script>
var s=null,logLines=[];
var sock=io();sock.on('state',function(d){s=d;render()});sock.on('log',function(l){logLines.push(l);if(logLines.length>300)logLines.shift();renderLog()});
function f2(n){return n==null?'--':Number(n).toFixed(2)}function f3(n){return n==null?'--':Number(n).toFixed(3)}
function sg(n){return n>0?'+\$'+f2(n):n<0? '-\$'+f2(Math.abs(n)):'\$'+f2(n)}function cl(n){return n>0?'green':n<0?'red':''}
function bx(l,v){return '<div class="box"><div class="lb">'+l+'</div><div class="val">'+v+'</div></div>'}
function esc(x){return String(x||'').replace(/</g,'&lt;')}function q(id){return document.getElementById(id)}
function fmtBtc(v){if(!v)return'--';return '\$'+Math.round(Number(v)).toLocaleString()}
function render(){if(!s)return;
 q('mode').textContent=s.dryRun?'DEMO':'LIVE';q('mode').className='badge '+(s.dryRun?'demo':'live');
 q('timer').textContent=s.secsLeft;
 q('top').innerHTML=bx('CAPITAL','\$'+f2(s.capital+s.realizedPnl))+bx('PNL','<span class="'+cl(s.realizedPnl)+'">'+sg(s.realizedPnl)+'</span>')+bx('W/L','<span class="green">'+(s.wins||0)+'W</span>/<span class="red">'+(s.losses||0)+'L</span>')+bx('WIN RATE',s.winRate!=null?s.winRate+'%':'--');
 q('upP').textContent=f3(s.upMid);q('dnP').textContent=f3(s.downMid);q('fairP').textContent=f3(s.fairUp);q('btcP').textContent=fmtBtc(s.btcPrice);q('beatP').textContent=fmtBtc(s.btcOpen);
 var pa=q('posarea');if(s.positions&&s.positions.length){var h='';s.positions.forEach(function(p,i){var mid=p.side==='up'?s.upMid:s.downMid;var fl=p.shares*mid-p.cost;
  h+='<div class="poscard" style="border-color:'+(fl>=0?'#00ff88':'#ff4444')+'"><div class="posline">'+esc(p.side.toUpperCase())+' '+f2(p.shares)+' SH @'+f2(p.entryPrice)+'</div><div class="posdetail">Cost \$'+f2(p.cost)+' · Mark '+f3(mid)+' · Float <span class="'+cl(fl)+'">'+sg(fl)+'</span></div></div>'});pa.innerHTML=h}
 else pa.innerHTML='<div style="color:#444;padding:4px 0">NO OPEN POSITIONS</div>';
 renderChart();
 var hh='';(s.history||[]).forEach(function(x){hh+='<div><span class="'+cl(x.pnl)+'">'+sg(x.pnl)+'</span> · '+x.side+' · '+x.winner+'</div>'});
 q('hist').innerHTML=hh||'<div style="color:#444">No trades yet</div>';
}
function renderChart(){if(!s||!s.equityCurve||s.equityCurve.length<2)return;
 var vals=s.equityCurve.map(function(x){return x.equity});vals.push(s.capital);var lo=Math.min.apply(null,vals),hi=Math.max.apply(null,vals),rg=(hi-lo)||1;
 q('eqline').setAttribute('points',s.equityCurve.map(function(v,i){return((i/(s.equityCurve.length-1)*600).toFixed(1))+','+((90-(v.equity-lo)/rg*78).toFixed(1))}).join(' '))}
function renderLog(){var el=q('log');if(!el)return;el.innerHTML=logLines.slice(-150).map(function(l){var c='';if(l.indexOf('EDGE')>=0)c='class="acc"';else if(l.indexOf('❌')>=0)c='class="red"';else if(l.indexOf('WIN')>=0)c='class="green"';return '<div '+c+'>'+esc(l)+'</div>'}).join('')}
setInterval(render,500);fetch('/api/status').then(function(r){return r.json()}).then(function(d){s=d;render()});
</script></body></html>`;
app.get('/',(_,r)=>r.type('html').send(HTML));

console.log('BTC Convergence Hunter — fair-value vs CLOB mispricing');
server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Dashboard http://0.0.0.0:${PORT}`);
  (async()=>{
    trader=new PolymarketTrader(privateKey);
    await trader.authenticate();
    slog(`⚙️ $${BASE_STAKE} flat | trade ${TRADE_START}-${TRADE_END}s | edge >${(EDGE_THRESHOLD*100).toFixed(0)}% | max 2 positions | ${DRY_RUN?'DEMO':'LIVE'}`);
    loop();
  })().catch(e=>{console.error('init warning:',e.message);slog(`⚠️ auth failed: ${e.message} — dashboard still running`)});
});
