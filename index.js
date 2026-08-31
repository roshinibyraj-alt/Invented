'use strict';

const express = require('express');
const { FlipBotEngine } = require('./engine');

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

const app = express();
const port = Number(process.env.PORT || 3000);

const engine = new FlipBotEngine({
  name: 'Invented',
  onLog: line => console.log(`[FLIP] ${line}`),
});

app.disable('x-powered-by');
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json(engine.buildState()));

const dashboard = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invented — BTC 5m</title>
<style>
*{box-sizing:border-box}
:root{--bg:#000;--panel:#070707;--line:#222;--muted:#9d9d9d;--up:#00ff85;--down:#ff4a68;--amber:#ffc400;--blue:#38d6ff}
html,body{background:#000;color:#fff;font-family:Arial,Helvetica,sans-serif;font-weight:800;margin:0}
body{padding:10px;font-size:15px}.wrap{max-width:1200px;margin:auto}
.topbar{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:8px}
.btc{width:38px;height:38px;border-radius:50%;background:#f7931a;display:grid;place-items:center;font-size:22px}
h1{font-size:19px;margin:0;line-height:1.1;text-transform:uppercase}
.sub{font-size:10px;color:var(--muted);letter-spacing:.4px;margin-top:2px}
.status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.pill{border:1px solid var(--line);padding:4px 7px;font-size:10px;white-space:nowrap;border-radius:6px}
.live{color:var(--up);border-color:#084b31}.warn{color:var(--amber);border-color:#5a4300}.bad{color:var(--down);border-color:#5c1622}.blue{color:var(--blue);border-color:#0d3a4a}
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
.chart{width:100%;height:150px;display:block}
.mini{background:#000;border:1px solid var(--line);padding:6px;border-radius:6px}
.mini .label{font-size:8px}.mini .value{font-size:13px}
.list{max-height:220px;overflow:auto;margin-top:6px}
.result,.trade-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid #161616;padding:7px 0;font-size:12px}
.buy{color:var(--up)}.sell{color:var(--down)}.dim{color:var(--muted);font-size:10px;font-weight:700}
.logs{height:200px;overflow:auto;background:#010407;border-radius:8px;padding:8px;font-family:"Courier New",monospace;font-size:10px;line-height:1.45;color:#e4e4e4;margin-top:6px;white-space:pre-wrap}
.log-win{color:var(--up)}.log-loss{color:var(--down)}.log-tp{color:var(--amber)}.log-info{color:var(--blue)}
.orders{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
.order{border:1px solid var(--line);padding:8px;border-radius:6px;background:#000}
.order.fill{color:var(--up);border-color:#084b31}.order.rest{color:var(--amber);border-color:#5a4300}
.order.cancel{color:var(--muted)}
@media(max-width:860px){.metrics{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}}
@media(max-width:720px){body{padding:6px;font-size:13px}h1{font-size:16px}.topbar{grid-template-columns:1fr}.side-price{font-size:28px}.clock{font-size:30px}}
</style>
</head>
<body><div class="wrap">
<header class="topbar">
<div class="brand"><div class="btc">₿</div><div><h1>Invented</h1><div class="sub" id="strategy">LOADING…</div></div></div>
<div class="status"><span id="waitPill" class="pill warn">WAIT —</span><span id="statusPill" class="pill bad">OFFLINE</span><span id="tickPill" class="pill">TICKS 0</span><span id="uptimePill" class="pill blue">00:00:00</span></div>
</header>
<div class="box equity" style="margin-bottom:8px">
<div class="section-head"><span>Lifetime Equity</span><span id="equityPeakLabel"></span></div>
<svg class="chart" id="equityChart"></svg>
</div>
<div class="metrics">
<div class="box"><div class="label">Bankroll</div><div class="value" id="bankroll">$1,000</div></div>
<div class="box"><div class="label">Mark Value</div><div class="value" id="markValue">$1,000</div></div>
<div class="box"><div class="label">Total P&L</div><div class="value" id="totalPnl">+$0.00</div></div>
<div class="box"><div class="label">Realized</div><div class="value" id="realizedPnl">+$0.00</div></div>
<div class="box"><div class="label">Unrealized</div><div class="value" id="unrealizedPnl">$0</div></div>
<div class="box"><div class="label">Total Fees</div><div class="value neg" id="totalFees">$0.00</div></div>
<div class="box"><div class="label">Window</div><div class="value" id="windowTime">—</div><div class="small" id="entryHint"></div></div>
<div class="box"><div class="label">Wins / Losses</div><div class="value" id="winLoss">0 / 0</div><div class="small" id="winRate"></div></div>
<div class="box"><div class="label">Entry # / Status</div><div class="value" id="flipInfo">0 / —</div><div class="small" id="baseInfo">BASE 0 SH</div></div>
<div class="box"><div class="label">Max Drawdown</div><div class="value neg" id="maxDrawdown">$0.00</div></div>
<div class="box"><div class="label">Peak Capital</div><div class="value pos" id="peakCapital">$1,000</div></div>
<div class="box"><div class="label">Highest Martingale</div><div class="value amb" id="maxMartingaleEver">M0</div><div class="small" id="maxSharesEver">0 SH</div><div class="small">Deepest before win: <span id="deepestBeforeWin">M0</span> · Loses before win: <span id="consecLosesBeforeWin">0</span></div></div>
</div>
<div class="two-col">
<div>
<div class="box market">
<div class="section-head"><span>Live BTC 5m</span><span id="windowTitle"></span></div>
<div id="marketBody"><div class="empty">Waiting for market...</div></div>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>Flip Engine — wait 45s, first entry 0.65–0.70 band, SL 0.50, re-enter ≥ 0.65 ×2</span></div>
<div id="orderBody"><div class="empty">No entries yet this window</div></div>
</div>
<div class="box" id="posBox" style="margin-bottom:8px;display:none">
<div class="section-head"><span>Open Positions</span></div>
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
const S={};
const ESC=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const $=id=>document.getElementById(id);
const money=n=>{n=n||0;return(n>=0?'+':'−')+('$'+Math.abs(n).toFixed(2))};
const cash=n=>'$'+Number(n||0).toFixed(2);
const num=n=>Number(n||0).toLocaleString();
const prc=n=>n!=null?Number(n).toFixed(3):'—';
const tone=n=>n>=0?'pos':'neg';
function uptimeFmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0')}
function renderMarket(m){const b=$('marketBody');if(!m){b.innerHTML='<div class="empty">Waiting for market...</div>';return}const r=m.remaining||0,e=m.elapsed||0;
b.innerHTML='<div class="clock">'+r+'s<small> T+'+e+'s · entry @ window start</small></div><div class="prices">'
+'<div class="side up"><div class="side-name">▲ UP</div><div class="side-price">'+prc(m.up.mid)+'</div>'
+'<div class="quote-row"><span>Bid</span><span>'+prc(m.up.bid)+'</span></div>'
+'<div class="quote-row"><span>Ask</span><span>'+prc(m.up.ask)+'</span></div>'
+(m.up.spread!=null?'<div class="spread">SPR '+prc(m.up.spread)+'</div>':'')+'</div>'
+'<div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price">'+prc(m.down.mid)+'</div>'
+'<div class="quote-row"><span>Bid</span><span>'+prc(m.down.bid)+'</span></div>'
+'<div class="quote-row"><span>Ask</span><span>'+prc(m.down.ask)+'</span></div>'
+(m.down.spread!=null?'<div class="spread">SPR '+prc(m.down.spread)+'</div>':'')+'</div></div>'}
function renderOrders(list){const b=$('orderBody');if(!list||!list.length){b.innerHTML='<div class="empty">No entries yet — waiting for a side to reach the entry level</div>';return}
b.innerHTML='<div class="orders">'+list.map((f,i)=>{const cls=f.outcome==='UP'?'up':'down';
return '<div class="order fill"><div>'+(f.isReentry?'RE-ENTRY #'+(f.entryNo||0):'ENTRY #'+(f.entryNo||0))+' '+num(f.shares)+' SH @ '+prc(f.entryPrice)+'</div>'
+'<div class="dim">COST '+cash(f.cost)+' · '+(f.outcome==='UP'?'▲ UP':'▼ DOWN')+'</div></div>'}).join('')+'</div>'}
function renderPositions(list){const box=$('posBox'),b=$('posBody');if(!list||!list.length){box.style.display='none';return}box.style.display='block';
b.innerHTML=list.map(p=>{const cls=p.outcome==='UP'?'pos-up':'pos-down';const mark=p.markPrice!=null?p.markPrice:p.entryPrice;
return '<div class="box" style="margin-bottom:6px"><div class="section-head"><span>'+(p.outcome==='UP'?'▲ UP':'▼ DOWN')+' '+num(p.shares)+' SH</span><span class="'+tone(p.unrealized)+'">'+money(p.unrealized)+'</span></div>'
+'<div class="dim">ENTRY #'+(p.entryNo||0)+(p.isReentry?' · RE-ENTRY':'')+' · ENTRY '+prc(p.entryPrice)+' · MARK '+prc(mark)+' · COST '+cash(p.cost)+' · SL @ 0.50 · HOLD TO RESOLUTION</div>'
+'<div class="dim">'+num(p.shares)+' × '+prc(mark)+' = '+cash(p.shares*mark)+' · '+p.remaining+'s left</div></div>'}).join('')}
function renderResults(a){const b=$('resBody'),ct=$('resCount');ct.textContent=a.length;
b.innerHTML=!a.length?'<div class="empty">NO RESOLVED POSITIONS YET</div>':a.map(r=>{const side=r.outcome==='UP'?'▲ UP':'▼ DOWN';const cls=r.pnl>=0?'buy':'sell';const lbl=r.exitReason||'';return '<div class="result"><div><span class="'+cls+'">'+side+' '+lbl+'</span><div class="dim">'+new Date(r.closedAt).toLocaleTimeString()+' · '+num(r.shares)+'sh @ '+prc(r.entryPrice)+' · '+(r.win?'WIN':'')+(r.won!=null?(r.won?'WIN':'LOSS'):'')+'</div></div><div class="'+cls+'">'+money(r.pnl)+'</div></div>'}).join('')}
function renderFeed(a){const b=$('feedBody'),ct=$('feedCount');ct.textContent=a.length;
b.innerHTML=!a.length?'<div class="empty">WAITING FOR TRADE</div>':a.map(tr=>{const isBuy=tr.type==='BUY';const cls=isBuy?'buy':'sell';const side=tr.outcome==='UP'?'▲ UP':'▼ DOWN';
return '<div class="trade-item"><div><span class="'+cls+'">'+ESC(tr.type)+' '+side+'</span>'
+'<div class="dim">'+new Date(tr.timestamp).toLocaleTimeString()+' · '+num(tr.shares)+'sh @ '+prc(tr.price)+(tr.reason?' · '+ESC(tr.reason):'')+'</div></div>'
+'<div style="text-align:right">'+cash(tr.cost)+(tr.pnl!=null?'<div class="'+cls+'">'+money(tr.pnl)+'</div>':'')+'</div></div>'}).join('')}
function renderLogs(a){const b=$('logBody'),ct=$('logCount');ct.textContent=a.length+' LINES';b.innerHTML=a.slice(-50).map(l=>{let c='';if(l.includes('WIN'))c='log-win';else if(l.includes('LOSS'))c='log-loss';else if(l.includes('TP'))c='log-tp';else if(l.includes('🎯')||l.includes('🛑')||l.includes('🏁'))c='log-info';return '<div class="'+c+'">'+ESC(l)+'</div>'}).join('')}
function renderConfig(c){if(!c)return;const b=$('configBody');b.innerHTML='<div class="mini"><div class="label">Wait</div><div class="value">'+c.waitSeconds.toFixed(0)+'s</div></div>'
+'<div class="mini"><div class="label">Entry</div><div class="value">'+c.entryPrice.toFixed(2)+'</div></div>'
+'<div class="mini"><div class="label">Stop Loss</div><div class="value">'+c.slPrice.toFixed(2)+'</div></div>'
+'<div class="mini"><div class="label">Re-entry</div><div class="value">'+c.reentryPrice.toFixed(2)+'</div></div>'
+'<div class="mini"><div class="label">Base (1% cap)</div><div class="value">'+num(c.baseShares)+' sh</div></div>'
+'<div class="mini"><div class="label">Base (10% cap)</div><div class="value">'+num(c.baseShares)+' sh</div></div>'
+'<div class="mini"><div class="label">M'+(c.maxMartingale||0)+' Steps Used</div><div class="value">'+num(c.reentryCount||0)+' / '+(c.maxMartingale||0)+'</div></div>'
+'<div class="mini"><div class="label">Next Shares</div><div class="value">'+num(c.nextShares)+' sh</div></div>'
+'<div class="mini"><div class="label">Slippage Ceiling</div><div class="value">'+(c.slippageCap!=null?c.slippageCap.toFixed(2):'0.99')+'</div></div>'
+'<div class="mini"><div class="label">Taker Fee</div><div class="value">'+(c.takerFeeRate!=null?(c.takerFeeRate*100).toFixed(2)+'%':'7.00%')+'</div></div>'
+'<div class="mini"><div class="label">Demo Capital</div><div class="value">'+cash(c.bankroll)+'</div></div>'}
function renderChart(c){const svg=$('equityChart');const epl=$('equityPeakLabel');if(epl)epl.textContent='VALUE '+cash(S.markValue||0)+' · PEAK '+cash(S.peakEquity||0);if(!c||!c.length){svg.innerHTML='';return}
const v=c.map(p=>p.equity),lo=Math.min(...v),hi=Math.max(...v),rng=(hi-lo)||1;const W=700,H=120,P=12;
const pts=c.map((p,i)=>[i/Math.max(1,c.length-1)*W,H-P-(p.equity-lo)/rng*(H-P*2)]);
const path='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');const last=pts.at(-1)||[0,H/2];
const color=S.totalPnl>=0?'#00ff85':'#ff4a68';
svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>'}
function renderKpi(d){$('bankroll').textContent=cash(d.bankroll);$('markValue').textContent=cash(d.markValue);
const tp=d.totalPnl||0;const te=$('totalPnl');te.textContent=money(tp);te.className='value '+tone(tp);
const rp=d.realizedPnl||0;const re=$('realizedPnl');re.textContent=money(rp);re.className='value '+tone(rp);
const up=d.unrealizedPnl||0;const ue=$('unrealizedPnl');ue.textContent=money(up);ue.className='value '+tone(up);
const tf=$('totalFees');if(tf)tf.textContent=cash(d.totalFeesPaid||0);
$('winLoss').textContent=(d.wins||0)+' / '+(d.losses||0);$('winRate').textContent=d.winRate!=null?'Win '+d.winRate+'%':'';
$('maxDrawdown').textContent=cash(d.maxDrawdown||0);
const pk=$('peakCapital');if(pk)pk.textContent=cash(d.peakEquity||0);
const mm=$('maxMartingaleEver');if(mm)mm.textContent='M'+(d.maxReentryEver||0);
const ms=$('maxSharesEver');if(ms)ms.textContent=num(d.maxSharesEver||0)+' SH';
const dbw=$('deepestBeforeWin');if(dbw)dbw.textContent='M'+(d.maxDeepestBeforeWin||0);
const clbw=$('consecLosesBeforeWin');if(clbw)clbw.textContent=(d.maxConsecLosesBeforeWin||0);
$('windowTime').textContent=d.windowRemaining!=null?d.windowRemaining+'s':'—';
const eh=$('entryHint');const waitSec=(d.config&&d.config.waitSeconds)||7;if(d.windowPaused){eh.textContent='⛔ '+ESC(d.pauseReason||'PAUSED')}else if(d.waitingForWindow){eh.textContent='WAITING FOR NEXT WINDOW'}else if(d.noMoreEntries){eh.textContent='⛔ MARTINGALE CAP REACHED · NO MORE ENTRIES THIS WINDOW'}else if(d.windowElapsed!=null&&d.windowElapsed<waitSec){eh.textContent='WAIT '+(waitSec-d.windowElapsed)+'s → first entry in 0.65–0.70'}else if(d.openEntry){eh.textContent='HOLDING '+(d.openEntry==='UP'?'▲ UP':'▼ DOWN')+' · SL @ 0.50'}else if(d.awaitingReentry){eh.textContent='WAITING RE-ENTRY @ 0.65 · NEXT '+num(d.nextShares)+' SH'}else{eh.textContent='READY · WAIT SIDE IN 0.65–0.70';}
eh.style.color=(d.windowPaused||d.noMoreEntries)?'#ff4a68':'';
const fi=$('flipInfo');if(fi){const oe=d.openEntry||'—';fi.textContent=(d.reentryCount||0)+' / '+(d.config&&d.config.maxMartingale?d.config.maxMartingale:2)+' RE · '+num(d.nextShares||0)+' NEXT';fi.className='value '+(oe==='UP'?'pos':oe==='DOWN'?'neg':'');}
const bi=$('baseInfo');if(bi){bi.textContent='BASE '+num(d.baseShares||0)+' SH (10%) · NEXT '+num(d.nextShares||0)+' SH';}
const wp=$('waitPill');if(wp){if(d.windowPaused){wp.textContent='PAUSED';wp.className='pill bad'}else if(d.waitingForWindow){const ww=Math.max(0,Math.ceil((d.entryWindow-Math.floor(Date.now()/1000))));wp.textContent='WAIT '+ww+'s';wp.className='pill warn'}else{wp.textContent='TRADING';wp.className='pill live'}};$('tickPill').textContent='TICKS '+(d.tickCount||0);
$('uptimePill').textContent=uptimeFmt(d.uptime||0);
const sp=$('statusPill');if(d.connected){sp.textContent='● LIVE';sp.className='pill live'}else{sp.textContent='● OFFLINE';sp.className='pill bad'}
const m=d.currentWindow;if(m){$('windowTitle').textContent=m.remaining+'s LEFT'}else{$('windowTitle').textContent=''}
}
function fullRender(d){Object.assign(S,d);$('strategy').textContent=d.strategy||'';renderKpi(d);renderMarket(d.currentWindow);renderOrders(d.positions||[]);renderPositions(d.positions);renderResults(d.results);renderFeed(d.trades);renderLogs(d.logs);renderConfig(d.config);renderChart(d.equityCurve)}
async function poll(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();fullRender(d)}catch(e){const sp=$('statusPill');if(sp){sp.textContent='● OFFLINE';sp.className='pill bad'}}}
setInterval(poll,700);poll();
</script></body></html>`;

app.get('/', (_, res) => res.type('html').send(dashboard));

app.listen(port, '0.0.0.0', () => {
  console.log(`FlipBot listening on :${port}`);
  engine.init().catch(e => console.error(`Init: ${e.message}`));
});
