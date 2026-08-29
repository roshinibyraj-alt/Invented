'use strict';
const express = require('express');
const http = require('http');
const { BotEngine, loadEquityFile } = require('./engine');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 8080;
const EQUITY_FILE = process.env.EQUITY_FILE || require('path').join(__dirname, 'equity.json');
const initialEquity = loadEquityFile(EQUITY_FILE);
const engine = new BotEngine({ initialEquity, onLog: l => console.log(l) });

const dashboard = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ModelBot — BTC 5m</title>
<style>
*{box-sizing:border-box}:root{--bg:#000;--panel:#070707;--line:#222;--muted:#9d9d9d;--up:#00ff85;--down:#ff4a68;--amber:#ffc400;--blue:#38d6ff}
html,body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}.wrap{max-width:1200px;margin:auto}
.topbar{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:8px}
.btc{width:38px;height:38px;border-radius:50%;background:#f7931a;display:grid;place-items:center;font-size:22px}
h1{font-size:19px;margin:0;line-height:1.1;text-transform:uppercase}
.sub{font-size:10px;color:var(--muted);letter-spacing:.4px;margin-top:2px}
.status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.pill{border:1px solid var(--line);padding:4px 7px;font-size:10px;white-space:nowrap;border-radius:6px}
.live{color:var(--up);border-color:#084b31}.bad{color:var(--down);border-color:#5c1622}.blue{color:var(--blue);border-color:#0d3a4a}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px}
.box,.panel{background:var(--panel);border:1px solid var(--line);padding:9px;border-radius:8px}
.label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.value{font-size:19px;margin-top:2px}.value.pos{color:var(--up)}.value.neg{color:var(--down)}.value.amb{color:var(--amber)}
.small{font-size:9px;color:var(--muted);margin-top:2px}
.two-col{display:grid;grid-template-columns:minmax(280px,1fr) minmax(260px,.75fr);gap:8px}
.clock{font-size:36px;line-height:1}.clock small{font-size:12px;color:var(--muted)}
.market{margin-bottom:8px}
.prices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.side{border:1px solid var(--line);padding:9px;background:#000;border-radius:8px}
.side-name{font-size:12px}.side-price{font-size:32px;line-height:1;margin:3px 0}
.side.up .side-price{color:var(--up)}.side.down .side-price{color:var(--down)}
.quote-row{display:flex;justify-content:space-between;font-size:12px}.quote-row span:last-child{color:#ddd}
.spread{display:inline-block;font-size:10px;color:var(--amber);margin-top:2px}
.section-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#fff;text-transform:uppercase}
.empty{color:var(--muted);padding:10px;border:1px dashed #333;text-align:center}
.chart{width:100%;height:120px;display:block}
.mini{background:#000;border:1px solid var(--line);padding:6px;border-radius:6px}
.mini .label{font-size:8px}.mini .value{font-size:13px}
.list{max-height:220px;overflow:auto;margin-top:6px}
.result,.trade-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #161616;padding:7px 0;font-size:12px}
.buy{color:var(--up)}.sell{color:var(--down)}.dim{color:var(--muted);font-size:10px;font-weight:700}
.logs{height:200px;overflow:auto;background:#010407;border-radius:8px;padding:8px;font-family:"Courier New",monospace;font-size:10px;line-height:1.45;color:#e4e4e4;margin-top:6px;white-space:pre-wrap}
.log-win{color:var(--up)}.log-loss{color:var(--down)}.log-tp{color:var(--amber)}.log-info{color:var(--blue)}
.ind-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin-top:6px}
.ind{background:#000;border:1px solid var(--line);border-radius:6px;padding:5px 7px;display:flex;justify-content:space-between;align-items:center}
.ind-name{font-size:9px;color:var(--muted)}.ind-score{font-size:14px;font-weight:800}
.ind-pos{color:var(--up)}.ind-neg{color:var(--down)}.ind-zero{color:var(--muted)}
.position-card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}
.pos-head{display:flex;justify-content:space-between;align-items:center}.pos-name{font-size:20px}.pos-side{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px}
.pos-up{color:var(--up);border:1px solid #084b31}.pos-down{color:var(--down);border:1px solid #5c1622}
.pnl{font-size:28px;margin:4px 0}.pos-meta{font-size:10px;color:var(--muted);margin-bottom:6px}
@media(max-width:860px){.metrics{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}}
@media(max-width:720px){body{padding:6px;font-size:13px}h1{font-size:16px}.topbar{grid-template-columns:1fr}.side-price{font-size:28px}.pnl{font-size:24px}.clock{font-size:30px}}
</style>
</head>
<body><div class="wrap">
<header class="topbar">
<div class="brand"><div class="btc">₿</div><div><h1>ConfidenceBot</h1><div class="sub">7-INDICATOR SIGNAL · CONF≥70% FOLLOW SIGNAL · FLAT 1000 SH · HOLD TO RESOLUTION</div></div></div>
<div class="status"><span id="statusPill" class="pill bad">OFFLINE</span><span id="tickPill" class="pill">TICKS 0</span><span id="uptimePill" class="pill blue">00:00:00</span></div>
</header>
<div class="metrics">
<div class="box"><div class="label">Bankroll</div><div class="value" id="bankroll">$20,000</div></div>
<div class="box"><div class="label">Mark Value</div><div class="value" id="markValue">$20,000</div></div>
<div class="box"><div class="label">Total P&L</div><div class="value" id="totalPnl">$0</div></div>
<div class="box"><div class="label">Realized</div><div class="value" id="realizedPnl">$0</div></div>
<div class="box"><div class="label">Confidence</div><div class="value" id="confidence">—</div><div class="small" id="confLean"></div></div>
<div class="box"><div class="label">Window</div><div class="value" id="windowTime">—</div><div class="small" id="entryWindow"></div></div>
<div class="box"><div class="label">Wins / Losses</div><div class="value" id="winLoss">0 / 0</div><div class="small" id="winRate"></div></div>
<div class="box"><div class="label">Max Drawdown</div><div class="value neg" id="maxDrawdown">$0</div></div>
<div class="box" id="recoveryBox"><div class="label">Recovery Mode</div><div class="value" id="recoveryStatus">OFF</div><div class="small" id="recoveryDetails">DEBT $0</div></div>
</div>
<div class="two-col">
<div>
<div class="box market">
<div class="section-head"><span>Live BTC 5m</span><span id="windowTitle"></span></div>
<div id="marketBody"><div class="empty">Waiting for market...</div></div>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Signal — 7 Indicators</span><span id="totalScore"></span></div>
<div class="ind-grid" id="indGrid"></div>
</div>
<div class="box" id="posBox" style="margin-bottom:8px;display:none">
<div class="section-head"><span>Open Position</span></div>
<div id="posBody"></div>
</div>
<div class="box">
<div class="section-head"><span>Resolved</span><span id="resCount"></span></div>
<div class="list"><div id="resBody"></div></div>
</div>
</div>
<div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Config</span></div>
<div id="configBody" style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px;margin-top:6px"></div>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Equity</span></div>
<svg class="chart" id="equityChart"></svg>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Trade Feed</span><span id="feedCount"></span></div>
<div class="list"><div id="feedBody"></div></div>
</div>
<div class="box">
<div class="section-head"><span>Logs</span><span id="logCount"></span></div>
<div class="logs" id="logBody"></div>
</div>
</div>
</div></div>
<script>
const S={};let polls=0;
const ESC=s=>String(s).replace(/[&<>"]/g,c=>({'+':'&#43;','&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const $=id=>document.getElementById(id);
const money=n=>{n=n||0;return(n>=0?'+':'−')+('$'+Math.abs(n).toFixed(2))};
const cash=n=>'$'+Number(n||0).toFixed(2);
const num=n=>Number(n||0).toLocaleString();
const prc=n=>n!=null?Number(n).toFixed(3):'—';
const tone=n=>n>=0?'pos':'neg';
function uptimeFmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0')}
function renderMarket(m){const b=$('marketBody');if(!m){b.innerHTML='<div class="empty">Waiting for market...</div>';return}const r=m.remaining||0,e=m.elapsed||0;
b.innerHTML='<div class="clock">'+r+'s<small> T+'+e+'s · conf entry any time</small></div><div class="prices">'
+'<div class="side up"><div class="side-name">▲ UP</div><div class="side-price">'+prc(m.up.mid)+'</div>'
+'<div class="quote-row"><span>Bid</span><span>'+prc(m.up.bid)+'</span></div>'
+'<div class="quote-row"><span>Ask</span><span>'+prc(m.up.ask)+'</span></div>'
+(m.up.spread!=null?'<div class="spread">SPR '+prc(m.up.spread)+'</div>':'')+'</div>'
+'<div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price">'+prc(m.down.mid)+'</div>'
+'<div class="quote-row"><span>Bid</span><span>'+prc(m.down.bid)+'</span></div>'
+'<div class="quote-row"><span>Ask</span><span>'+prc(m.down.ask)+'</span></div>'
+(m.down.spread!=null?'<div class="spread">SPR '+prc(m.down.spread)+'</div>':'')+'</div></div>';
$('windowTitle').textContent=m.title||''}
function renderSignal(sig){if(!sig||!sig.indicators)return;
const g=$('indGrid');
const inds=[['Δ Window',sig.indicators.windowDelta],['Momentum',sig.indicators.microMomentum],['Accel',sig.indicators.acceleration],['EMA 9/21',sig.indicators.ema921],['RSI 14',sig.indicators.rsi14],['Vol Surge',sig.indicators.volumeSurge],['Tick Trend',sig.indicators.tickTrend]];
g.innerHTML=inds.map(([n,v])=>{const s=v?.score||0;const cls=s>0?'ind-pos':s<0?'ind-neg':'ind-zero';
let extra='';if(v?.deltaPct!=null)extra=v.deltaPct.toFixed(3)+'%';if(v?.rsi!=null)extra='RSI '+v.rsi;if(v?.consistency!=null)extra=Math.round(v.consistency*100)+'% '+(v.direction||'');if(v?.ema9!=null)extra=v.ema9+' / '+v.ema21;if(v?.surge!=null)extra=v.surge+'x';
return '<div class="ind"><div><div class="ind-name">'+n+'</div></div><div class="ind-score '+cls+'">'+(s>=0?'+':'')+s.toFixed(1)+(extra?' <span style="font-size:9px;color:#999;font-weight:400">'+extra+'</span>':'')+'</div></div>'}).join('');
const sc=sig.score||0;const cs=$('totalScore');cs.textContent='Score '+sc.toFixed(1)+' · '+(sig.lean||'NEUTRAL');
cs.style.color=sc>0?'var(--up)':sc<0?'var(--down)':'var(--muted)';
const conf=$('confidence');conf.textContent=sig.confidence!=null?(sig.confidence*100).toFixed(1)+'%':'—';
const cl=$('confLean');if(sig.lean==='UP'){cl.textContent='→ BUY UP';cl.style.color='var(--up)'}else if(sig.lean==='DOWN'){cl.textContent='→ BUY DOWN';cl.style.color='var(--down)'}else{cl.textContent='→ NEUTRAL · no entry';cl.style.color='var(--muted)'}
}
function renderPosition(positions){const box=$('posBox'),b=$('posBody');if(!positions||!positions.length){box.style.display='none';return}
box.style.display='';b.innerHTML=positions.map(p=>{const cls=p.outcome==='UP'?'pos-up':'pos-down';
return '<div class="position-card" style="margin-bottom:6px"><div class="pos-head"><span class="pos-name">'+(p.outcome==='UP'?'▲':'▼')+' '+p.outcome+'</span><span class="pos-side '+cls+'">'+(p.betLabel||'HOLDING')+'</span></div>'
+'<div class="pnl '+tone(p.unrealized)+'">'+money(p.unrealized)+'</div>'
+'<div class="pos-meta">'+num(p.shares)+' SH @ '+prc(p.entryPrice)+' · cost '+cash(p.cost)+' · conf '+(p.confidence*100).toFixed(0)+'% · mark '+prc(p.markPrice)+'</div></div>'}).join('');
}
function renderResults(r){const b=$('resBody');if(!r||!r.length){b.innerHTML='<div class="empty">No resolved yet</div>';return}
b.innerHTML=r.slice(0,15).map(p=>{const w=p.won===true;return '<div class="result"><div><span class="'+(w?'buy':'sell')+'">'+(w?'✅':'❌')+' '+ESC((p.asset||'').toUpperCase())+' '+(p.outcome||'')+'</span>'
+'<div class="dim">conf '+(p.signalConf*100).toFixed(0)+'% · '+num(p.shares)+'sh @ '+prc(p.entryPrice)+(p.exitReason?' · '+p.exitReason:'')+'</div></div>'
+'<div class="'+(p.pnl>=0?'buy':'sell')+'">'+money(p.pnl)+'</div></div>'}).join('');$('resCount').textContent=r.length+' BETS'}
function renderFeed(t){const b=$('feedBody'),ct=$('feedCount');if(!t||!t.length){b.innerHTML='<div class="empty">No trades</div>';ct.textContent='0';return}
ct.textContent=t.length;b.innerHTML=t.slice(0,30).map(tr=>{const isBuy=tr.type==='BUY';const cls=isBuy?'buy':'sell';
return '<div class="trade-item"><div><span class="'+cls+'">'+tr.type+' '+ESC(tr.outcome||'')+'</span>'
+'<div class="dim">'+new Date(tr.timestamp).toLocaleTimeString()+' · '+num(tr.shares)+'sh @ '+prc(tr.price)+(tr.confidence!=null?' · conf '+(tr.confidence*100).toFixed(0)+'%':'')+'</div></div>'
+'<div style="text-align:right">'+cash(tr.cost)+(tr.pnl!=null?'<div class="'+(tr.pnl>=0?'buy':'sell')+'">'+money(tr.pnl)+'</div>':'')+'</div></div>'}).join('')}
function renderLogs(a){const b=$('logBody'),ct=$('logCount');ct.textContent=a.length+' LINES';b.innerHTML=a.slice(-50).map(l=>{let c='';if(l.includes('WIN'))c='log-win';else if(l.includes('LOSS'))c='log-loss';else if(l.includes('💰'))c='log-tp';else if(l.includes('ENTRY')||l.includes('EXIT')||l.includes('RESOLUTION'))c='log-info';return '<div class="'+c+'">'+ESC(l)+'</div>'}).join('')}
function renderConfig(c){if(!c)return;const b=$('configBody');b.innerHTML='<div class="mini"><div class="label">Entry After</div><div class="value">'+(c.entryMinElapsed??c.entryElapsed??0)+'s</div></div>'
+'<div class="mini"><div class="label">Min Conf</div><div class="value">'+((c.minConfidence??c.highConf??0)*100)+'%</div></div>'
+'<div class="mini"><div class="label">Sizing</div><div class="value">'+(c.flatShares??0)+' sh</div></div>'
+'<div class="mini"><div class="label">Reversal</div><div class="value">'+(c.reversalPct??0)+'%</div></div>'
+'<div class="mini"><div class="label">Reversal ≥</div><div class="value">'+((c.reversalConsist??0)*100)+'%</div></div>'
+'<div class="mini"><div class="label">Fee</div><div class="value">'+((c.takerFeeRate??0)*100)+'%</div></div>'}
function renderChart(c){const svg=$('equityChart');if(!c||!c.length){svg.innerHTML='';return}
const v=c.map(p=>p.equity),lo=Math.min(...v),hi=Math.max(...v),rng=(hi-lo)||1;const W=700,H=120,P=12;
const pts=c.map((p,i)=>[i/Math.max(1,c.length-1)*W,H-P-(p.equity-lo)/rng*(H-P*2)]);
const path='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');const last=pts.at(-1)||[0,H/2];
const color=S&&S.totalPnl>=0?'#00ff85':'#ff4a68';
svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>'}
function renderKpi(d){$('bankroll').textContent=cash(d.bankroll);$('markValue').textContent=cash(d.markValue);
const tp=d.totalPnl||0;const te=$('totalPnl');te.textContent=money(tp);te.className='value '+tone(tp);
const rp=d.realizedPnl||0;const re=$('realizedPnl');re.textContent=money(rp);re.className='value '+tone(rp);
$('winLoss').textContent=(d.wins||0)+' / '+(d.losses||0);$('winRate').textContent=d.winRate!=null?'Win '+d.winRate+'%':'';
$('maxDrawdown').textContent=cash(d.maxDrawdown);
const rec=d.recovery||{};
const rb=$('recoveryBox');
if(rec.active){
  $('recoveryStatus').textContent=rec.multiplier+'x (L'+(rec.level+1)+')';
  $('recoveryStatus').className='value negative';
  $('recoveryDetails').textContent='DEBT $'+Math.round(rec.debt)+' · WINDOW '+(rec.windows)+'/'+(rec.hold)+' · NEXT '+num(d.nextShares)+' SH';
  rb.style.borderColor='#5c1622';
}else{
  $('recoveryStatus').textContent='OFF';
  $('recoveryStatus').className='value';
  $('recoveryDetails').textContent='NEXT '+num(d.nextShares)+' SH · CAP '+(rec.cap||4)+'x';
  rb.style.borderColor='';
}polls++;$('tickPill').textContent='TICKS '+(d.tickCount||0);
$('uptimePill').textContent=uptimeFmt(d.uptime||0);
const sp=$('statusPill');if(d.connected){sp.textContent='● LIVE';sp.className='pill live'}else{sp.textContent='● OFFLINE';sp.className='pill bad'}
const m=d.markets&&d.markets[0];if(m){$('windowTime').textContent=m.remaining+'s';$('entryWindow').textContent='T-'+(d.config?.entryTMinus||10)+'s entry'}else{$('windowTime').textContent='—';$('entryWindow').textContent=''}
}
function fullRender(d){Object.assign(S,d);renderKpi(d);renderMarket(d.markets&&d.markets[0]);renderSignal(d.signal);renderPosition(d.positions);renderResults(d.resolvedPositions);renderFeed(d.trades);renderLogs(d.logs);renderConfig(d.config);renderChart(d.equityCurve)}
async function poll(){try{const r=await fetch('/api/status');const d=await r.json();fullRender(d)}catch(e){const sp=$('statusPill');if(sp){sp.textContent='● OFFLINE';sp.className='pill bad'}}}
setInterval(poll,1000);poll();
</script></body></html>`;

app.get('/healthz', (_, res) => res.sendStatus(200));
app.get('/api/status', (_, res) => res.json(engine.buildState()));
app.get('/', (_, req) => req.type('html').send(dashboard));
server.listen(port, '0.0.0.0', () => {
  console.log(`ModelBot listening on :${port}`);
  engine.init().catch(e => console.error(`Init: ${e.message}`));
});
