'use strict';

const express = require('express');
const { CheapHunterEngine } = require('./engine');

process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));
process.on('uncaughtException', (err) => console.error('[FATAL]', err));

const app = express();
const port = Number(process.env.PORT || 3000);

const engine = new CheapHunterEngine({
  name: '3 Check Bot',
  onLog: line => console.log(`[CH] ${line}`),
});

app.disable('x-powered-by');
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json(engine.buildState()));

const dashboard = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>3 Check Bot — BTC 5m</title>
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
.prices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.side{border:1px solid var(--line);padding:9px;background:#000;border-radius:8px}
.side-name{font-size:12px}.side-price{font-size:32px;line-height:1;margin:3px 0}
.side.up .side-price{color:var(--up)}.side.down .side-price{color:var(--down)}
.quote-row{display:flex;justify-content:space-between;font-size:12px}.quote-row span:last-child{color:#ddd}
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
.check-bar{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px}
.check-box{border:1px solid var(--line);padding:8px;border-radius:6px;background:#000;text-align:center}
.check-box.fired{border-color:var(--amber)}.check-box.done{border-color:#333;opacity:.5}
.check-id{font-size:11px;color:var(--muted)}.check-val{font-size:18px;margin-top:2px}
.check-val.wait{color:var(--amber)}.check-val.fired{color:var(--up)}.check-val.done{color:#555}
@media(max-width:860px){.metrics{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}}
@media(max-width:480px){body{padding:6px;font-size:13px}h1{font-size:16px}.topbar{grid-template-columns:1fr}.side-price{font-size:28px}.clock{font-size:30px}.check-val{font-size:15px}}
</style></head><body><div class="wrap">
<header class="topbar">
<div class="brand"><div class="btc">₿</div><div><h1>3 Check Bot</h1><div class="sub" id="strategy">LOADING…</div></div></div>
<div class="status"><span id="statusPill" class="pill bad">OFFLINE</span><span id="uptimePill" class="pill blue">00:00:00</span></div>
</header>
<div class="box equity" style="margin-bottom:8px">
<div class="section-head"><span>Lifetime Equity</span><span id="equityPeakLabel"></span></div>
<svg class="chart" id="equityChart"></svg></div>
<div class="metrics">
<div class="box"><div class="label">Bankroll</div><div class="value" id="bankroll">$300</div></div>
<div class="box"><div class="label">Total P&L</div><div class="value" id="totalPnl">+$0.00</div></div>
<div class="box"><div class="label">Realized</div><div class="value" id="realizedPnl">+$0.00</div></div>
<div class="box"><div class="label">Fees</div><div class="value neg" id="totalFees">$0.00</div></div>
<div class="box"><div class="label">Window</div><div class="value" id="windowTime">—</div><div class="small" id="entryHint"></div></div>
<div class="box"><div class="label">Wins / Losses</div><div class="value" id="winLoss">0 / 0</div><div class="small" id="winRate"></div></div>
<div class="box"><div class="label">Open Positions</div><div class="value" id="openCount">0</div><div class="small" id="unrealizedPnl"></div></div>
<div class="box"><div class="label">Max Drawdown</div><div class="value neg" id="maxDrawdown">$0.00</div></div>
</div>
<div class="box" style="margin-bottom:8px">
<div class="section-head"><span>3 Checks — Window Status</span></div>
<div class="check-bar" id="checkBar">
<div class="check-box" id="cb1"><div class="check-id">CHECK 1</div><div class="check-val" id="cv1">WAIT</div><div class="small">≤ 0.35 @ 9s</div></div>
<div class="check-box" id="cb2"><div class="check-id">CHECK 2</div><div class="check-val" id="cv2">WAIT</div><div class="small">≤ 0.25 @ 17s</div></div>
<div class="check-box" id="cb3"><div class="check-id">CHECK 3</div><div class="check-val" id="cv3">WAIT</div><div class="small">≤ 0.20 @ 30s</div></div>
</div></div>
<div class="two-col"><div>
<div class="box" style="margin-bottom:8px"><div class="section-head"><span>BTC UP / DOWN</span><span id="windowTitle"></span></div>
<div id="marketBody"><div class="empty">Waiting for market…</div></div></div>
<div class="box" id="posBox" style="margin-bottom:8px;display:none"><div class="section-head"><span>Open Positions</span></div><div id="posBody"></div></div>
<div class="box"><div class="section-head"><span>Resolved</span><span id="resCount"></span></div><div class="list"><div id="resBody"></div></div></div>
</div><div>
<div class="box" style="margin-bottom:8px"><div class="section-head"><span>Config</span></div>
<div id="configBody" style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px;margin-top:6px"></div></div>
<div class="box" style="margin-bottom:8px"><div class="section-head"><span>Trade Feed</span><span id="feedCount"></span></div><div class="list"><div id="feedBody"></div></div></div>
<div class="box"><div class="section-head"><span>Logs</span><span id="logCount"></span></div><div class="logs" id="logBody"></div></div>
</div></div></div>
<script>
const ESC=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const $=id=>document.getElementById(id);
const money=n=>{n=n||0;return(n>=0?'+':'−')+('$'+Math.abs(n).toFixed(2))};
const cash=n=>'$'+Number(n||0).toFixed(2);
const num=n=>Number(n||0).toLocaleString();
const prc=n=>n!=null?Number(n).toFixed(3):'—';
const tone=n=>n>=0?'pos':'neg';
function uptimeFmt(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0')}
let S={};
function renderKpi(d){$('bankroll').textContent=cash(d.bankroll);const tp=d.totalPnl||0;const te=$('totalPnl');te.textContent=money(tp);te.className='value '+tone(tp);const rp=d.realizedPnl||0;const re=$('realizedPnl');re.textContent=money(rp);re.className='value '+tone(rp);$('totalFees').textContent=cash(d.totalFeesPaid||0);$('winLoss').textContent=(d.wins||0)+' / '+(d.losses||0);$('winRate').textContent=d.winRate!=null?'Win '+d.winRate+'%':'';$('maxDrawdown').textContent=cash(d.maxDrawdown||0);$('windowTime').textContent=d.windowRemaining!=null?d.windowRemaining+'s':'—';$('openCount').textContent=d.openEntryCount||0;const up=d.unrealizedPnl||0;const ue=$('unrealizedPnl');if(ue){ue.textContent=money(up);ue.className='small '+tone(up)}
const eh=$('entryHint');const elapsed=d.windowElapsed||0;const checks=d.checks||[];const allDone=checks.length>0&&checks.every(c=>c.fired);if(d.waitingForWindow){eh.textContent='WAITING FOR NEXT WINDOW'}else if(d.openEntryCount>0){eh.textContent='HOLDING POSITION(S) · HOLD TO RESOLUTION'}else if(allDone){eh.textContent='ALL CHECKS EXPIRED'}else{eh.textContent='SCANNING '+checks.filter(c=>!c.fired).length+' CHECK(S)'}
for(const c of checks){const cv=$('cv'+c.id);const cb=$('cb'+c.id);if(c.fired){cv.textContent='FIRED ✓';cv.className='check-val fired';cb.className='check-box fired'}else{const remaining=c.timeout-elapsed;cv.textContent=remaining>0?remaining+'s':'SCAN…';cv.className='check-val wait';cb.className='check-box'}}
const wp=$('statusPill');if(d.connected){wp.textContent='● LIVE';wp.className='pill live'}else{wp.textContent='● OFFLINE';wp.className='pill bad'}$('uptimePill').textContent=uptimeFmt(d.uptime||0);const mt=d.currentWindow;if(mt){$('windowTitle').textContent=mt.remaining+'s LEFT'}else{$('windowTitle').textContent=''}}
function renderMarket(m){const b=$('marketBody');if(!m){b.innerHTML='<div class="empty">Waiting for market…</div>';return}b.innerHTML='<div class="clock">'+m.remaining+'s<small> T+'+m.elapsed+'s</small></div><div class="prices"><div class="side up"><div class="side-name">▲ UP</div><div class="side-price">'+prc(m.up.mid)+'</div><div class="quote-row"><span>Bid</span><span>'+prc(m.up.bid)+'</span></div><div class="quote-row"><span>Ask</span><span>'+prc(m.up.ask)+'</span></div></div><div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price">'+prc(m.down.mid)+'</div><div class="quote-row"><span>Bid</span><span>'+prc(m.down.bid)+'</span></div><div class="quote-row"><span>Ask</span><span>'+prc(m.down.ask)+'</span></div></div></div>'}
function renderPositions(a){const b=$('posBody'),pb=$('posBox');if(!a||!a.length){pb.style.display='none';return}pb.style.display='';b.innerHTML=a.map(p=>{const cls=p.outcome==='UP'?'pos':'neg';const mark=p.markPrice!=null?p.markPrice:p.entryPrice;return '<div class="trade-item"><div><span class="'+cls+'">'+(p.outcome==='UP'?'▲ UP':'▼ DOWN')+'</span><div class="dim">CHECK '+(p.entryNo||'?')+' · '+num(p.shares)+'sh @ '+prc(p.entryPrice)+' · MARK '+prc(mark)+' · TP @ 0.50</div></div><div class="'+tone(p.unrealized)+'">'+money(p.unrealized)+'</div></div>'}).join('')}
function renderResults(a){const b=$('resBody'),ct=$('resCount');ct.textContent=(a?a.length:0)+' RESOLVED';b.innerHTML=!a||!a.length?'<div class="empty">NO RESOLVED POSITIONS YET</div>':a.map(r=>{const side=r.outcome==='UP'?'▲ UP':'▼ DOWN';const cls=r.pnl>=0?'buy':'sell';return '<div class="result"><div><span class="'+cls+'">'+side+' '+(r.exitReason||'')+'</span><div class="dim">'+new Date(r.closedAt).toLocaleTimeString()+' · '+num(r.shares)+'sh @ '+prc(r.entryPrice)+' · '+(r.won?'WIN':'LOSS')+'</div></div><div class="'+cls+'">'+money(r.pnl)+'</div></div>'}).join('')}
function renderFeed(a){const b=$('feedBody'),ct=$('feedCount');ct.textContent=(a?a.length:0)+' TRADES';b.innerHTML=!a||!a.length?'<div class="empty">NO TRADES YET</div>':a.map(tr=>{const isBuy=tr.type==='BUY';const cls=isBuy?'buy':'sell';const side=tr.outcome==='UP'?'▲ UP':'▼ DOWN';return '<div class="trade-item"><div><span class="'+cls+'">'+(isBuy?'BUY':'SELL')+' '+side+'</span><div class="dim">'+new Date(tr.timestamp).toLocaleTimeString()+' · '+num(tr.shares)+'sh @ '+prc(tr.price)+'</div></div><div class="'+cls+'">'+money(tr.pnl||0)+'</div></div>'}).join('')}
function renderLogs(a){const b=$('logBody'),ct=$('logCount');ct.textContent=(a?a.length:0)+' LINES';b.innerHTML=(a||[]).slice(-50).map(l=>{let cls='';if(l.includes('WIN'))cls='log-win';else if(l.includes('LOSS'))cls='log-loss';else if(l.includes('💰'))cls='log-tp';else if(l.includes('🎯')||l.includes('🏁')||l.includes('CHECK'))cls='log-info';return '<div class="'+cls+'">'+ESC(l)+'</div>'}).join('')}
function renderConfig(c){if(!c)return;const b=$('configBody');const ch=(c.checks||[]).map(x=>'<div class="mini"><div class="label">Check '+x.id+'</div><div class="value">≤'+x.threshold.toFixed(2)+' @ '+x.timeout+'s</div></div>').join('');b.innerHTML=ch+'<div class="mini"><div class="label">Base %</div><div class="value">'+(c.basePct*100)+'%</div></div><div class="mini"><div class="label">Capital</div><div class="value">'+cash(c.bankroll)+'</div></div><div class="mini"><div class="label">Taker Fee</div><div class="value">'+(c.takerFeeRate!=null?(c.takerFeeRate*100).toFixed(2)+'%':'7%')+'</div></div>'}
function renderChart(c){const svg=$('equityChart'),epl=$('equityPeakLabel');if(epl)epl.textContent='VALUE '+cash(S.markValue||0)+' · PEAK '+cash(S.peakEquity||0);if(!c||!c.length){svg.innerHTML='';return}const v=c.map(p=>p.equity),lo=Math.min(...v),hi=Math.max(...v),rng=(hi-lo)||1;const W=700,H=120,P=12;const pts=c.map((p,i)=>[i/Math.max(1,c.length-1)*W,H-P-(p.equity-lo)/rng*(H-P*2)]);const path='M'+pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L');const last=pts.at(-1)||[0,H/2];const color=S.totalPnl>=0?'#00ff85':'#ff4a68';svg.innerHTML='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/><circle cx="'+last[0]+'" cy="'+last[1]+'" r="4" fill="'+color+'"/>'}
function fullRender(d){Object.assign(S,d);$('strategy').textContent=d.strategy||'';renderKpi(d);renderMarket(d.currentWindow);renderPositions(d.positions);renderResults(d.results);renderFeed(d.trades);renderLogs(d.logs);renderConfig(d.config);renderChart(d.equityCurve)}
async function poll(){try{const r=await fetch('/api/status',{cache:'no-store'});const d=await r.json();fullRender(d)}catch(e){const sp=$('statusPill');if(sp){sp.textContent='● OFFLINE';sp.className='pill bad'}}}
setInterval(poll,700);poll();
</script></body></html>`;

app.get('/', (_, res) => res.type('html').send(dashboard));

app.listen(port, '0.0.0.0', () => {
  console.log(`CheapHunter listening on :${port}`);
  engine.init().catch(e => console.error('Init:', e.message));
});
