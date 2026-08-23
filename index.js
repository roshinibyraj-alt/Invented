'use strict';
const path=require('path'),fs=require('fs'),express=require('express'),http=require('http');
const {Server}=require('socket.io');
const PolymarketTrader=require('./polymarket-trader');

const DRY_RUN=(process.env.DRY_RUN||'true').toLowerCase()==='true';
const CAPITAL=Number(process.env.CAPITAL||4000);
const BASE_STAKE=Number(process.env.BASE_STAKE_USD||100);
const CLOB='https://clob.polymarket.com';
const PORT=process.env.PORT||8080;
const OBSERVE_START=270,OBSERVE_END=285;

const app=express(),server=http.createServer(app),io=new Server(server,{pingInterval:2000,pingTimeout:5000});
app.get('/healthz',(_,r)=>r.sendStatus(200));

const privateKey=process.env.PRIVATE_KEY;
if(!privateKey){console.error('PRIVATE_KEY missing');process.exit(1);}
let trader=null,realizedPnl=0,wins=0,losses=0,totalFees=0,equityCurve=[],history=[],logs=[];
const emit=(ev,d)=>io.emit(ev,d);
const slog=line=>{console.log(line);logs.push(line);if(logs.length>300)logs.shift();io.emit('log',line);};

async function j(url){const r=await fetch(url);if(!r.ok)throw new Error(r.status+' '+url);return r.json();}
function round2(v){return Math.round(v*100)/100}
function money(v){return(v>0?'+$':v<0?'-$':'$')+Math.abs(v).toFixed(2)}

// ─── BTC Price ───────────────────────────────────────────────────────────────
async function btcPrice(){try{const d=await j('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');return parseFloat(d.price)}catch(_){return null}}
async function btcOpen(ts){try{const k=await j(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime=${ts*1000}&endTime=${ts*1000+1000}&limit=1`);return k.length?parseFloat(k[0][1]):null}catch(_){return null}}

// ─── Polymarket Leg ──────────────────────────────────────────────────────────
async function discoverLeg(ts){
  try{
    const [e]=await j('https://gamma-api.polymarket.com/events?slug=btc-updown-5m-'+ts);
    if(!e)return null;
    const m=e.markets[0];
    const tokens=m.clobTokenIds?JSON.parse(m.clobTokenIds):[];
    return {ts,slug:'btc-updown-5m-'+ts,upToken:tokens[0],downToken:tokens[1],discovered:true,resolved:false,winner:null};
  }catch(_){return null}
}

// ─── Strategy State ──────────────────────────────────────────────────────────
let leg=null,btcOpenPrice=null,ticks=[],fired=false,position=null,lastDiscovery=0,lastBtc=0,lastBtcFetch=0,lastEquity=0;
let upMid=null,downMid=null,lastClobFetch=0;
let pendingResolutions=[];

async function fetchClobPrices(){
  if(!leg?.discovered||!leg.upToken)return;
  try{
    const [bu,bd]=await Promise.all([
      j(CLOB+'/midpoint?token_id='+leg.upToken).catch(()=>null),
      j(CLOB+'/midpoint?token_id='+leg.downToken).catch(()=>null),
    ]);
    if(bu?.mid)upMid=parseFloat(bu.mid);
    if(bd?.mid)downMid=parseFloat(bd.mid);
  }catch(_){}
}

function avgVelocity(){
  if(ticks.length<3)return 0;
  let sum=0;for(let i=1;i<ticks.length;i++)sum+=ticks[i].price-ticks[i-1].price;
  return sum/(ticks.length-1);
}

function projectedPrice(current){
  const vel=avgVelocity();
  const secsLeft=300-leg.elapsedSecond();
  return current+(vel*secsLeft);
}

async function fire(direction){
  if(!leg||!leg.discovered||fired)return;
  fired=true;
  const token=direction==='up'?leg.upToken:leg.downToken;
  const side=direction.toUpperCase();
  slog(`🎯 ${side} SIGNAL — velocity ${(avgVelocity()*100).toFixed(2)}¢/tick → projected $${projectedPrice(lastBtc).toFixed(2)} vs beat $${btcOpenPrice?.toFixed(2)}`);
  try{
    const mid=direction==='up'?upMid:downMid;
    if(DRY_RUN){
      const entryPrice=mid||0.50;
      const shares=Math.floor(BASE_STAKE/entryPrice*100)/100;
      position={side:direction.toLowerCase(),shares,entryPrice,cost:round2(shares*entryPrice),shares2:shares};
      totalFees+=round2(position.cost*0.07*(1-entryPrice));
      slog(`✅ DEMO ${side} BUY ${shares}sh @${entryPrice} | cost $${position.cost}`);
    }else{
      const order=await trader.placeFokBuy(token,BASE_STAKE);
      if(!order.isFilled){slog(`❌ ${side} FOK rejected`);fired=false;return;}
      const fp=parseFloat(order.avgPrice)||0.50;
      const rawShares=parseFloat(order.raw?.takingAmount||order.raw?.size_matched||'0');
      const sh=rawShares>0?round2(rawShares):Math.floor(BASE_STAKE/fp*100)/100;
      position={side:direction.toLowerCase(),shares:sh,entryPrice:fp,cost:BASE_STAKE};
      slog(`✅ LIVE ${side} BUY ${sh}sh @${fp}`);
    }
  }catch(e){slog(`❌ ${side} buy error: ${e.message}`);fired=false;}
}

function resetWindow(ts){
  leg={windowTs:ts,elapsedSecond:()=>Math.floor((Date.now()/1000)-ts),discovered:false};
  ticks=[];fired=false;btcOpenPrice=null;lastDiscovery=0;
  slog(`🆕 window t=${ts}`);
}

// ─── Main Loop ──────────────────────────────────────────────────────────────
async function loop(){
  while(true){
    try{
      const nowSec=Math.floor(Date.now()/1000);
      const ts=Math.floor(nowSec/300)*300;
      if(!leg||leg.windowTs!==ts){
        if(leg&&leg.windowTs!==ts&&!leg.resolved){
          pendingResolutions.push({leg:{...leg},position});
          slog(`⏳ window ended — resolution pending for ${leg.slug}`);
          if(position)position=null;
        }
        resetWindow(ts);
      }
      for(let i=pendingResolutions.length-1;i>=0;i--){
        const pr=pendingResolutions[i];
        const resolved=await tryResolve(pr.leg);
        if(resolved){
          settleWith(pr.position,pr.leg.winner);
          pendingResolutions.splice(i,1);
        }
      }
      if(!leg.discovered&&nowSec-lastDiscovery>=500){
        lastDiscovery=nowSec;
        const l=await discoverLeg(ts);
        if(l){Object.assign(leg,l);slog(`🎯 discovered ${l.slug}`);}
      }
      // BTC price every tick (200ms)
      if(nowSec*1000+Date.now()%1000-lastBtcFetch>=200){
        lastBtcFetch=nowSec*1000+Date.now()%1000;
        const p=await btcPrice();
        if(p!=null){
          lastBtc=p;
          if(btcOpenPrice==null&&leg.discovered)btcOpenPrice=await btcOpen(ts);
          if(leg.discovered&&btcOpenPrice!=null){
            const sec=leg.elapsedSecond();
            if(sec>=OBSERVE_START&&sec<OBSERVE_END){
              ticks.push({t:sec,price:p});
            }
            if(sec>=OBSERVE_END&&!fired&&ticks.length>=3){
              const proj=projectedPrice(p);
              const direction=proj>btcOpenPrice?'up':'down';
              await fire(direction);
            }
          }
        }
      }
      // CLOB prices every tick
      if(Date.now()-lastClobFetch>=200){
        lastClobFetch=Date.now();
        await fetchClobPrices();
      }
      // Equity curve
      if(nowSec-lastEquity>=1){
        lastEquity=nowSec;
        let unrealized=0;
        if(position&&lastBtc)unrealized=position.shares*(position.entryPrice)-position.cost;
        equityCurve.push({t:Date.now(),equity:round2(CAPITAL+realizedPnl+unrealized)});
        if(equityCurve.length>600)equityCurve.shift();
      }
      emitState();
    }catch(e){slog(`⚠️ ${e.message}`);}
    await new Promise(r=>setTimeout(r,200));
  }
}

async function tryResolve(oldLeg){
  try{
    const [e]=await j('https://gamma-api.polymarket.com/events?slug='+oldLeg.slug);
    if(e?.markets?.[0]?.closed){
      const prices=JSON.parse(e.markets[0].outcomePrices||'[0,0]');
      oldLeg.winner=parseFloat(prices[0])>=0.5?'up':'down';
      oldLeg.resolved=true;
      return true;
    }
  }catch(_){}
  return false;
}

function settleWith(pos,winner){
  if(!pos)return;
  const won=winner===pos.side;
  const payout=won?pos.shares:0;
  const pnl=round2(payout-pos.cost);
  realizedPnl=round2(realizedPnl+pnl);
  if(pnl>0)wins++;else losses++;
  slog(`🏁 ${pos.side.toUpperCase()} RESOLVED ${won?'WIN':'LOSS'} — PnL ${money(pnl)}`);
  history.unshift({ts:Date.now(),winner:pnl>=0?'WIN':'LOSS',side:pos.side.toUpperCase(),pnl});
}

// ─── API + Dashboard ────────────────────────────────────────────────────────
function buildState(){
  const elapsed=leg?.elapsedSecond?.()||0;
  const secsLeft=Math.max(0,300-elapsed);
  return {dryRun:DRY_RUN,capital:CAPITAL,baseStake:BASE_STAKE,realizedPnl,wins,losses,
    totalFees:round2(totalFees),equityCurve,history,
    btcPrice:lastBtc,btcOpen:btcOpenPrice,tickCount:ticks.length,fired,
    upMid,downMid,
    velocity:avgVelocity(),projected:lastBtc&&btcOpenPrice?projectedPrice(lastBtc):null,
    position,elapsed,secsLeft,legSlug:leg?.slug||null,discovered:!!leg?.discovered,
    winRate:(wins+losses)?round2(wins/(wins+losses)*100):null};
}
function emitState(){emit('state',buildState());}
app.get('/api/status',(_,r)=>r.json(buildState()));

const HTML=`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BTC Momentum Final</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#000;color:#fff;font-family:'Courier New',monospace;font-weight:bold;font-size:13px;padding:9px}
.h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.title{font-size:19px}.title span{color:#00ccff}.badge{padding:4px 10px;border-radius:14px;border:1px solid #333;font-size:11px}
.demo{color:#ffcc00;background:#ffcc0018}.live{color:#ff5566;background:#ff556618}
.timerbar{text-align:center;padding:12px;background:#050505;border:2px solid #222;border-radius:8px;margin-bottom:8px}.timerval{font-size:44px;color:#00ccff;font-variant-numeric:tabular-nums;line-height:1}.timerlbl{font-size:10px;color:#777;text-transform:uppercase;letter-spacing:2px;margin-top:4px}
.phase{display:inline-block;padding:3px 14px;border-radius:12px;font-size:11px;margin-top:7px}.observing{color:#ffcc00;background:#ffcc0015}.firedp{color:#00ff88;background:#00ff8815}.waiting{color:#666;background:#ffffff08}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px}.box{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:6px;padding:8px}.lb{font-size:9px;color:#777;text-transform:uppercase}.val{font-size:17px;margin-top:3px}
.green{color:#00ff88}.red{color:#ff4444}.acc{color:#00ccff}.warn{color:#ffcc00}
.card{background:#080808;border:1px solid #1e1e1e;border-radius:7px;padding:10px;margin-bottom:8px}
.prices{display:grid;grid-template-columns:1fr auto 1fr;gap:6px;text-align:center;padding:8px 0}.price{font-size:30px}.plabel{font-size:9px;color:#777;text-transform:uppercase;letter-spacing:1px}
.poscard{border-left:3px solid #333;padding-left:10px;margin-bottom:4px}.posline{font-size:18px}.posdetail{font-size:12px;color:#aaa;margin-top:4px;line-height:1.5}
.stratinfo{font-size:11px;color:#666;line-height:1.7;margin-top:8px;border-top:1px solid #1a1a1a;padding-top:8px}
#chart svg{width:100%;height:95px}#hist div,#log div{padding:5px 0;border-bottom:1px solid #151515;font-size:11px}
#hist{max-height:180px;overflow-y:auto}#log{max-height:250px;overflow-y:auto;background:#000;padding:8px;border:1px solid #1a1a1a;border-radius:5px;line-height:1.55;white-space:pre-wrap}
.sub{font-size:11px;color:#999;text-align:center;margin-top:6px}
@media(max-width:600px){.grid{grid-template-columns:repeat(2,1fr)}.val{font-size:14px}.price{font-size:24px}.timerval{font-size:36px}}</style></head><body>
<div class="h"><div class="title">BTC <span>MOMENTUM FINAL</span></div><div id="mode" class="badge demo">DEMO</div></div>
<div class="timerbar"><div class="timerval" id="timer">--</div><div class="timerlbl">SECONDS LEFT · 5M WINDOW</div><br><span id="phase" class="phase waiting">INITIALIZING…</span></div>
<div class="grid" id="top"></div>
<div class="card"><div class="prices">
<div><div class="plabel">UP</div><div class="price acc" id="upPrice">--</div></div>
<div><div class="plabel">BTC / USD</div><div class="price" style="color:#ffcc00" id="btcPrice">--</div></div>
<div><div class="plabel">DOWN</div><div class="price warn" id="downPrice">--</div></div>
</div><div id="btcdetail" class="sub"></div></div>
<div class="card"><div style="font-size:9px;color:#777;text-transform:uppercase;margin-bottom:7px">POSITION</div><div id="posarea"></div>
<div class="stratinfo">\$100 flat · observe BTC t=270–285s · extrapolate velocity to t=300s<br>Beat price captured at window open from Binance 1s kline</div></div>
<div class="card"><div style="font-size:9px;color:#777;text-transform:uppercase;margin-bottom:5px">EQUITY CURVE</div><div id="chart"><svg viewBox="0 0 600 95" preserveAspectRatio="none"><polyline id="eqline" fill="none" stroke="#00ccff" stroke-width="2.5"/></svg></div></div>
<div class="card"><div style="font-size:9px;color:#777;text-transform:uppercase;margin-bottom:5px">TRADE HISTORY</div><div id="hist"></div></div>
<div class="card"><div style="font-size:9px;color:#777;text-transform:uppercase;margin-bottom:5px">SERVER LOGS</div><div id="log"></div></div>
<script src="/socket.io/socket.io.js"></script><script>
var s=null,logLines=[];
var sock=io();sock.on('state',function(d){s=d;render()});sock.on('log',function(l){logLines.push(l);if(logLines.length>300)logLines.shift();renderLog()});
function f2(n){return n==null?'--':Number(n).toFixed(2)}function f3(n){return n==null?'--':Number(n).toFixed(3)}
function sg(n){return n>0?'+$'+f2(n):n<0?'-$'+f2(Math.abs(n)):'$'+f2(n)}function cl(n){return n>0?'green':n<0?'red':''}
function bx(l,v){return '<div class="box"><div class="lb">'+l+'</div><div class="val">'+v+'</div></div>'}
function esc(x){return String(x||'').replace(/</g,'&lt;')}function q(id){return document.getElementById(id)}
function fmtBtc(v){if(!v)return'--';return '$'+Math.round(Number(v)).toLocaleString()}
function render(){
 if(!s)return;
 q('mode').textContent=s.dryRun?'DEMO':'LIVE';q('mode').className='badge '+(s.dryRun?'demo':'live');
 q('timer').textContent=s.secsLeft!=null?s.secsLeft:'--';
 var ph=q('phase'),el=s.elapsed||0;
 if(s.fired){ph.textContent='FIRED — HOLDING';ph.className='phase firedp'}
 else if(el>=270&&el<285&&s.discovered){ph.textContent='OBSERVING ('+s.tickCount+' ticks)';ph.className='phase observing'}
 else if(el>=285&&s.tickCount>=3&&!s.fired){ph.textContent='SIGNAL READY';ph.className='phase firedp'}
 else if(el>=285){ph.textContent='INSUFFICIENT TICKS';ph.className='phase waiting'}
 else if(s.discovered){ph.textContent='MONITORING';ph.className='phase waiting'}
 else{ph.textContent='DISCOVERING LEG…';ph.className='phase waiting'}
 q('top').innerHTML=bx('CAPITAL','$'+f2(s.capital+s.realizedPnl))+bx('PNL','<span class="'+cl(s.realizedPnl)+'">'+sg(s.realizedPnl)+'</span>')+bx('WIN RATE',s.winRate!=null?s.winRate.toFixed(1)+'%':'--')+bx('FEES','$'+f2(s.totalFees));
 q('upPrice').textContent=f3(s.upMid);q('downPrice').textContent=f3(s.downMid);
 q('btcPrice').textContent=fmtBtc(s.btcPrice);
 var detail='Beat: '+fmtBtc(s.btcOpen)+' · Ticks: '+s.tickCount+' · Velocity: '+f3(s.velocity)+'$/tick · Elapsed: '+el+'s';
 if(s.projected!=null&&s.btcOpen!=null)detail+=' → Projected: '+fmtBtc(s.projected)+' '+(s.projected>s.btcOpen?'▲UP':'▼DOWN');
 q('btcdetail').textContent=detail;
 var pa=q('posarea'),p=s.position;
 if(p)pa.innerHTML='<div class="poscard" style="border-color:'+(p.unrealizedPnl>=0?'#00ff88':'#ff4444')+'"><div class="posline">'+esc((p.side||'').toUpperCase())+' · '+f2(p.shares)+' SH @'+f2(p.entryPrice)+'</div><div class="posdetail">Cost \$'+f2(p.cost)+' · Float <span class="'+cl(p.unrealizedPnl)+'">'+sg(p.unrealizedPnl||0)+'</span></div></div>';
 else pa.innerHTML='<div style="color:#444;font-size:13px;padding:4px 0">NO OPEN POSITION</div>';
 renderChart();
 var hh='';(s.history||[]).forEach(function(x,i){hh+='<div><span style="color:'+cl(x.pnl)+'">'+sg(x.pnl)+'</span> · '+x.side+' · '+x.winner+'</div>'});
 q('hist').innerHTML=hh||'<div style="color:#444;padding:4px 0">No trades yet</div>';
}
function renderChart(){if(!s||!s.equityCurve||s.equityCurve.length<2)return;
 var vals=s.equityCurve.map(function(x){return x.equity});vals.push(s.capital);var lo=Math.min.apply(null,vals),hi=Math.max.apply(null,vals),rg=(hi-lo)||1;
 var pts=s.equityCurve.map(function(v,i){return((i/(s.equityCurve.length-1)*600).toFixed(1))+','+((90-(v.equity-lo)/rg*78).toFixed(1))}).join(' ');
 q('eqline').setAttribute('points',pts)}
function renderLog(){var el=q('log');if(!el)return;var bottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
 el.innerHTML=logLines.slice(-150).map(function(l){var c='';if(l.indexOf('BUY')>=0)c='class="acc"';else if(l.indexOf('❌')>=0)c='class="red"';else if(l.indexOf('WIN')>=0||l.indexOf('✅')>=0)c='class="green"';return '<div '+c+'>'+esc(l)+'</div>'}).join('');
 if(bottom)el.scrollTop=el.scrollHeight}
setInterval(render,500);fetch('/api/status').then(function(r){return r.json()}).then(function(d){s=d;render()});
</script></body></html>`;
app.get('/',(_,r)=>r.type('html').send(HTML));

console.log('BTC Momentum Final — 270-285s observation, extrapolate & fire');
server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Dashboard http://0.0.0.0:${PORT}`);
  (async()=>{
    trader=new PolymarketTrader(privateKey);
    await trader.authenticate();
    slog(`⚙️ $${BASE_STAKE} flat · observe ${OBSERVE_START}-${OBSERVE_END}s · extrapolate & fire · ${DRY_RUN?'DEMO':'LIVE'}`);
    loop();
  })().catch(e=>{console.error('init:',e.message);process.exit(1)});
});
