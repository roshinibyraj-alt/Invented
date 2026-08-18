'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bot = require('./bot');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv, { pingInterval: 2000, pingTimeout: 5000 });
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.get('/healthz', (_, r) => r.sendStatus(200));
app.get('/api/status', (_, r) => { try { r.json(bot.buildState()); } catch(e) { r.status(500).json({error:e.message}); } });

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Momentum DCA Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:13px;font-weight:bold;-webkit-text-size-adjust:100%}
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #00ccff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:20px;color:#fff;letter-spacing:1px}.logo span{color:#00ccff}
.badge{padding:4px 12px;border-radius:20px;font-size:10px;font-weight:bold;background:#00ccff22;color:#00ccff;border:1px solid #00ccff}
.sg{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px 16px 0}
@media(min-width:600px){.sg{grid-template-columns:repeat(6,1fr)}}
.s{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:6px 8px}
.sl{font-size:7px;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.sv{font-size:14px;font-weight:bold;color:#fff}
.pos{color:#00ff88!important}.neg{color:#ff4444!important}
.eq{margin:10px 16px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
.eq-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.eq-hdr .t{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#666}
.eq-hdr .v{font-size:14px;font-weight:bold}
.eq svg{width:100%;height:60px;background:#111;border-radius:6px}
.sec{margin:10px 16px 0}
.sh{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:4px}
.card{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px}
.r{display:flex;justify-content:space-between;padding:2px 0;font-size:10px;font-weight:bold}
.r span:first-child{color:#666}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tb{border-collapse:collapse;min-width:300px;width:100%}
.tb th{background:#111;color:#666;padding:4px 5px;text-align:left;font-size:7px;text-transform:uppercase;white-space:nowrap}
.tb td{padding:3px 5px;border-bottom:1px solid #1a1a1a;font-size:9px;white-space:nowrap;font-weight:bold}
.lp{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px;max-height:200px;overflow-y:auto;overflow-x:auto;font-size:9px;line-height:1.4;white-space:nowrap;-webkit-overflow-scrolling:touch}
.lp div{padding:1px 0}
.pnl-pos{color:#00ff88!important}.pnl-neg{color:#ff4444!important}
.tag-up{color:#00ccff}.tag-dn{color:#aa88ff}
.empty{padding:12px;text-align:center;color:#444;font-size:9px;font-weight:bold}
.pill{display:inline-block;padding:1px 6px;border-radius:4px;font-size:8px;font-weight:bold}
.p-trading{background:#00ff8822;color:#00ff88;border:1px solid #00ff88}
.p-waiting{background:#ffcc0022;color:#ffcc00;border:1px solid #ffcc00}
.p-idle{background:#333;color:#888;border:1px solid #555}
</style></head><body>

<div class="hd">
  <div><div class="logo">\u26A1 MOMENTUM DCA</div></div>
  <div class="badge" id="mode">DEMO</div>
</div>

<div class="sg" id="stats"></div>

<div class="eq">
  <div class="eq-hdr"><div class="t">Equity Curve</div><div class="v" id="eq-val">\u2014</div></div>
  <svg id="eq-svg" viewBox="0 0 700 55" preserveAspectRatio="none"></svg>
</div>

<div class="sec">
  <div class="sh">\uD83D\uDCCA Current Window</div>
  <div class="card" id="cw"><div class="empty">Waiting\u2026</div></div>
</div>

<div class="sec">
  <div class="sh">\uD83D\uDCCB History</div>
  <div class="card"><div class="tw"><table class="tb">
    <tr><th>Window</th><th>Winner</th><th>UP</th><th>DN</th><th>Spent</th><th>Payout</th><th>P&L</th></tr>
    <tbody id="hb"></tbody>
  </table></div></div>
</div>

<div class="sec">
  <div class="sh">\uD83D\uDCDD Logs</div>
  <div class="lp" id="lp"></div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io({pingInterval:2000,pingTimeout:5000});
var S=null,lb=[];

function $(id){return document.getElementById(id)}
function ts(s){if(!s)return'\u2014';var d=new Date((typeof s==='number'?s*1000:s));return d.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function sgn(n){return(n>0?'+$':(n<0?'-$':'$'))+Math.abs(n).toFixed(2)}
function pC(n){return n>0?'pnl-pos':n<0?'pnl-neg':''}
function sv(l,v,c){return'<div class="s"><div class="sl">'+l+'</div><div class="sv '+(c||'')+'">'+v+'</div></div>'}
function fmtMs(ms){var s=Math.floor(ms/1000);var m=Math.floor(s/60);s=s%60;return m+':'+(s<10?'0':'')+s}
function short(s){return!s?'':s.length>18?s.slice(0,18)+'\u2026':s}

function svgCurve(pts,w,h,baseline){
  if(!pts||pts.length<2)return'';
  var mn=Infinity,mx=-Infinity;
  pts.forEach(function(p){if(p.equity<mn)mn=p.equity;if(p.equity>mx)mx=p.equity});
  var range=mx-mn||1;mn-=range*0.05;mx+=range*0.05;range=mx-mn;
  var last=pts[pts.length-1].equity;
  var col=last>=baseline?'#00ff88':'#ff4444';
  var d='M';
  pts.forEach(function(p,i){
    var x=(i/(pts.length-1))*w;
    var y=h-(((p.equity-mn)/range)*h);
    d+=(i?'L':'')+x.toFixed(1)+','+y.toFixed(1);
  });
  return'<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">'
    +'<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="2"/>'
    +'<line x1="0" y1="'+(h-(((baseline-mn)/range)*h))+'" x2="'+w+'" y2="'+(h-(((baseline-mn)/range)*h))+'" stroke="#333" stroke-width="1" stroke-dasharray="4"/>'
    +'</svg>';
}

function render(s){
  try{
  S=s;
  if(s.logs&&s.logs.length&&lb.length===0)lb=s.logs.slice(-200);
  if(s.logs){for(var i=0;i<s.logs.length;i++){if(lb.indexOf(s.logs[i])===-1)lb.push(s.logs[i]);}if(lb.length>500)lb=lb.slice(-300);}
  var logEl=$('lp');
  if(logEl){var atBot=logEl.scrollHeight-logEl.scrollTop-logEl.clientHeight<40;logEl.innerHTML=lb.slice(-150).map(function(l){var c=l.indexOf('WIN')>=0||l.indexOf('P&L +')>=0?'#00ff88':l.indexOf('LOSS')>=0||l.indexOf('P&L -$')>=0||l.indexOf('\u26A0')>=0?'#ff4444':l.indexOf('\uD83C\uDFC1')>=0?'#ffcc00':'#999';return'<div style="color:'+c+'">'+l.replace(/</g,'&lt;')+'</div>';}).join('');if(atBot)logEl.scrollTop=logEl.scrollHeight;}

  $('mode').textContent=s.dryRun?'DEMO':'LIVE';

  // Stats
  $('stats').innerHTML=[
    sv('Capital','$'+s.startingCapital.toFixed(0)),
    sv('Bankroll','$'+s.bankroll.toFixed(2)),
    sv('Equity','$'+s.equity.toFixed(2),pC(s.equity-s.startingCapital)),
    sv('P&L',sgn(s.realizedPnlTotal),pC(s.realizedPnlTotal)),
    sv('W/L',s.wins+'/'+s.losses),
    sv('Win%',s.winRate!=null?s.winRate+'%':'\u2014')
  ].join('');

  // Equity
  $('eq-val').textContent='$'+s.equity.toFixed(2);
  $('eq-val').className='v '+pC(s.equity-s.startingCapital);
  $('eq-svg').innerHTML=svgCurve(s.equityCurve,700,55,s.startingCapital);

  // Current window
  var t=s.current;
  if(!t){$('cw').innerHTML='<div class="empty">Waiting for next window\u2026</div>';}
  else{
    var ph=t.phase==='trading'?'p-trading':t.phase==='waiting'?'p-waiting':'p-idle';
    var html='<div class="r"><span>Window</span><span>'+short(t.slug)+'</span></div>'
      +'<div class="r"><span>Phase</span><span class="pill '+ph+'">'+t.phase+'</span></div>'
      +'<div class="r"><span>Time Left</span><span>'+fmtMs(t.timeLeft)+'</span></div>'
      +'<div class="r"><span>UP</span><span class="tag-up">'+(t.upAsk?t.upAsk.toFixed(3):'\u2014')+' ask / '+(t.upBid?t.upBid.toFixed(3):'\u2014')+' bid</span></div>'
      +'<div class="r"><span>DOWN</span><span class="tag-dn">'+(t.downAsk?t.downAsk.toFixed(3):'\u2014')+' ask / '+(t.downBid?t.downBid.toFixed(3):'\u2014')+' bid</span></div>'
      +'<div class="r"><span>UP Bought</span><span class="tag-up">'+t.upShares+'sh / $'+t.upCost.toFixed(2)+'</span></div>'
      +'<div class="r"><span>DN Bought</span><span class="tag-dn">'+t.dnShares+'sh / $'+t.dnCost.toFixed(2)+'</span></div>'
      +'<div class="r"><span>Total Spent</span><span>$'+t.totalSpent.toFixed(2)+' / $'+s.perWindowBudget+'</span></div>'
      +'<div class="r"><span>Shares</span><span>'+t.totalShares+'</span></div>'
      +'<div class="r"><span>Orders</span><span>'+t.buyCount+'</span></div>';
    $('cw').innerHTML=html;
  }

  // History
  $('hb').innerHTML=(s.history||[]).map(function(h){
    return'<tr><td title="'+h.slug+'">'+short(h.slug)+'</td>'
      +'<td>'+(h.winner?h.winner.toUpperCase():'\u2014')+'</td>'
      +'<td class="tag-up">'+h.upShares+'sh</td>'
      +'<td class="tag-dn">'+h.dnShares+'sh</td>'
      +'<td>$'+h.totalSpent.toFixed(2)+'</td>'
      +'<td>$'+h.payout.toFixed(2)+'</td>'
      +'<td class="'+pC(h.pnl)+'">'+sgn(h.pnl)+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="empty">No history yet</td></tr>';
  }catch(e){console.error('Render error:',e)}
}

socket.on('state',function(s){render(s)});
socket.on('log',function(line){
  lb.push(line);if(lb.length>400)lb.shift();
  var el=$('lp');if(!el)return;
  var atBot=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=lb.slice(-150).map(function(l){var c=l.indexOf('WIN')>=0||l.indexOf('P&L +')>=0?'#00ff88':l.indexOf('LOSS')>=0||l.indexOf('P&L -$')>=0?'#ff4444':l.indexOf('\uD83C\uDFC1')>=0?'#ffcc00':'#999';return'<div style="color:'+c+'">'+l.replace(/</g,'&lt;')+'</div>';}).join('');
  if(atBot)el.scrollTop=el.scrollHeight;
});
setInterval(function(){fetch('/api/status').then(function(r){return r.json()}).then(render).catch(function(){})},5000);
</script></body></html>`;

app.get('/', (_, res) => { res.type('html').send(DASHBOARD_HTML); });

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

console.log('\u26A1 Momentum DCA Bot');
srv.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard: http://0.0.0.0:' + PORT);
  bot.init(emit, slog).catch(e => { console.error('Init failed:', e.message); process.exit(1); });
});
