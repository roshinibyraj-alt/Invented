'use strict';

const express = require('express');
const { CheapHunterEngine } = require('./engine');

process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));
process.on('uncaughtException', (err) => console.error('[FATAL]', err));

const app = express();
const port = Number(process.env.PORT || 3000);

const engine = new CheapHunterEngine({
  name: 'PrevWinner',
  onLog: line => console.log(`[PW] ${line}`),
});

app.disable('x-powered-by');
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json(engine.buildState()));

const dashboard = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PrevWinner Bot — BTC 5m</title>
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
.prev-winner-bar{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center;margin-bottom:8px}
.prev-winner-box{border:1px solid var(--line);padding:10px;border-radius:8px;background:#000;text-align:center}
.prev-winner-box .side-label{font-size:28px;margin-top:2px}
.prev-winner-box .side-label.up{color:var(--up)}.prev-winner-box .side-label.down{color:var(--down)}.prev-winner-box .side-label.skip{color:var(--muted)}
.ladder-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px}
.ladder-cell{border:1px solid var(--line);padding:6px;border-radius:6px;background:#000;text-align:center;font-size:11px}
.ladder-cell.filled{border-color:var(--up);background:#084b31}.ladder-cell.pending{border-color:var(--line)}
.ladder-price{font-size:13px;margin-top:2px}
.ladder-shares{font-size:9px;color:var(--muted);margin-top:1px}
@media(max-width:860px){.metrics{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}.ladder-grid{grid-template-columns:repeat(4,1fr)}}
@media(max-width:480px){body{padding:6px;font-size:13px}h1{font-size:16px}.side-price{font-size:24px}.metrics{grid-template-columns:repeat(2,1fr)}}
</style>
</head><body>
<div class="wrap">
  <div class="topbar">
    <div class="brand"><div class="btc">₿</div><div><h1 id="botName">PrevWinner Bot</h1><div class="sub" id="strategy">BTC 5m Binary · Prev Winner Ladder</div></div></div>
    <div class="status">
      <span class="pill" id="statusPill">● CONNECTING</span>
      <span class="pill" id="pollPill">—</span>
      <span class="pill blue" id="timePill">—</span>
    </div>
  </div>

  <div class="metrics">
    <div class="box"><div class="label">Capital</div><div class="value" id="kpiBankroll">—</div></div>
    <div class="box"><div class="label">Total P&L</div><div class="value" id="kpiPnl">—</div></div>
    <div class="box"><div class="label">Wins</div><div class="value" id="kpiWins">—</div><div class="small" id="kpiWinRate"></div></div>
    <div class="box"><div class="label">Losses</div><div class="value" id="kpiLosses">—</div><div class="small" id="kpiMaxDd"></div></div>
  </div>

  <div class="prev-winner-bar" id="prevWinnerBar">
    <div class="prev-winner-box" style="min-width:140px">
      <div class="label">Prev Window Winner</div>
      <div class="side-label" id="prevWinnerSide">—</div>
    </div>
    <div class="panel" id="clockBox">
      <div class="label">Current Window</div>
      <div class="clock" id="clock">—<small> sec</small></div>
    </div>
  </div>

  <div class="prices" id="priceBar">
    <div class="side up">
      <div class="side-name">▲ UP</div>
      <div class="side-price" id="upPrice">—</div>
      <div class="quote-row"><span>BID</span><span id="upBid">—</span></div>
      <div class="quote-row"><span>ASK</span><span id="upAsk">—</span></div>
      <div class="quote-row"><span>SPREAD</span><span id="upSpread">—</span></div>
    </div>
    <div class="side down">
      <div class="side-name">▼ DOWN</div>
      <div class="side-price" id="downPrice">—</div>
      <div class="quote-row"><span>BID</span><span id="downBid">—</span></div>
      <div class="quote-row"><span>ASK</span><span id="downAsk">—</span></div>
      <div class="quote-row"><span>SPREAD</span><span id="downSpread">—</span></div>
    </div>
  </div>

  <div class="two-col" style="margin-top:8px">
    <div>
      <div class="panel">
        <div class="section-head"><span>Ladder — <span id="ladderSide">—</span></span><span id="ladderStatus">—</span></div>
        <div class="ladder-grid" id="ladderGrid"></div>
      </div>
      <div class="panel" style="margin-top:8px">
        <div class="section-head"><span id="posCount">0 OPEN</span></div>
        <div class="list" id="posBody"><div class="empty">NO OPEN POSITIONS</div></div>
      </div>
      <div class="panel" style="margin-top:8px">
        <div class="section-head"><span id="resCount">0 RESOLVED</span></div>
        <div class="list" id="resBody"><div class="empty">NO RESOLVED POSITIONS YET</div></div>
      </div>
    </div>
    <div>
      <div class="panel">
        <div class="section-head"><span>Equity Curve</span><span class="dim" id="equityPeakLabel">—</span></div>
        <svg class="chart" id="equityChart" viewBox="0 0 700 120"></svg>
      </div>
      <div class="panel" style="margin-top:8px">
        <div class="section-head"><span id="feedCount">0 TRADES</span></div>
        <div class="list" id="feedBody"><div class="empty">NO TRADES YET</div></div>
      </div>
      <div class="panel" style="margin-top:8px">
        <div class="section-head"><span id="logCount">0 LINES</span></div>
        <div class="logs" id="logBody"></div>
      </div>
      <div class="panel" style="margin-top:8px">
        <div class="section-head"><span>Config</span></div>
        <div id="configBody" style="margin-top:6px"></div>
      </div>
    </div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
const S={};
function money(v){if(v==null)return'—';return(v>=0?'+':'')+ '$' + Math.abs(v).toFixed(2)}
function prc(v){return v!=null?'$'+Number(v).toFixed(3):'—'}
function num(v){return v!=null?Number(v).toLocaleString():'—'}
function cash(v){return '$'+Number(v||0).toFixed(2)}
function tone(v){return v>0?'value pos':v<0?'value neg':'value amb'}
function ESC(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function renderKpi(d) {
  $('kpiBankroll').textContent = cash(d.bankroll);
  const pnl = d.totalPnl || 0;
  const pe = $('kpiPnl'); pe.textContent = money(pnl); pe.className = 'value ' + (pnl >= 0 ? 'pos' : 'neg');
  $('kpiWins').textContent = d.wins || 0;
  $('kpiWinRate').textContent = d.winRate != null ? d.winRate + '% WR' : '';
  $('kpiLosses').textContent = d.losses || 0;
  $('kpiMaxDd').textContent = d.maxDrawdown ? 'DD ' + cash(d.maxDrawdown) : '';
  // Status pills
  const sp = $('statusPill');
  if (d.connected) { sp.textContent = '● LIVE'; sp.className = 'pill live'; }
  else if (d.lastError) { sp.textContent = '● ERROR'; sp.className = 'pill bad'; }
  else { sp.textContent = '● OFFLINE'; sp.className = 'pill bad'; }
  $('pollPill').textContent = 'polls:' + (d.pollCount || 0);
  // Time
  if (d.currentWindow) {
    const rem = d.currentWindow.remaining;
    $('clock').innerHTML = rem + '<small> sec</small>';
    $('timePill').textContent = rem + 's left';
  }
  // Prev winner
  const pw = d.prevWindowWinner;
  const pws = $('prevWinnerSide');
  if (pw === 'UP') { pws.textContent = '▲ UP'; pws.className = 'side-label up'; }
  else if (pw === 'DOWN') { pws.textContent = '▼ DOWN'; pws.className = 'side-label down'; }
  else { pws.textContent = 'SKIP'; pws.className = 'side-label skip'; }
}
function renderMarket(m) {
  if (!m) return;
  $('upPrice').textContent = prc(m.up?.mid);
  $('upBid').textContent = prc(m.up?.bid);
  $('upAsk').textContent = prc(m.up?.ask);
  $('upSpread').textContent = m.up?.spread != null ? m.up.spread.toFixed(3) : '—';
  $('downPrice').textContent = prc(m.down?.mid);
  $('downBid').textContent = prc(m.down?.bid);
  $('downAsk').textContent = prc(m.down?.ask);
  $('downSpread').textContent = m.down?.spread != null ? m.down.spread.toFixed(3) : '—';
}
function renderLadder(d) {
  const ol = d.orderLadder;
  const grid = $('ladderGrid');
  const side = ol?.side || '—';
  $('ladderSide').textContent = side;
  const ladder = ol?.ladder || [];
  const pp = d.pendingOrders || [];
  const filled = pp.filter(o => o.status === 'FILLED');
  const pending = pp.filter(o => o.status === 'PENDING');
  $('ladderStatus').textContent = filled.length + '/' + ladder.length + ' filled';
  grid.innerHTML = ladder.map(r => {
    const fo = filled.find(f => f.limitPrice === r.price);
    const po = pending.find(f => f.limitPrice === r.price);
    if (fo) return '<div class="ladder-cell filled"><div class="ladder-price">$' + fo.limitPrice.toFixed(2) + '</div><div class="ladder-shares">' + fo.shares + 'sh FILL @ $' + fo.fillPrice.toFixed(2) + '</div></div>';
    if (po) return '<div class="ladder-cell pending"><div class="ladder-price">$' + po.limitPrice.toFixed(2) + '</div><div class="ladder-shares">' + po.shares + 'sh PENDING</div></div>';
    return '<div class="ladder-cell"><div class="ladder-price">$' + r.price.toFixed(2) + '</div><div class="ladder-shares">' + r.shares + 'sh</div></div>';
  }).join('');
}
function renderPositions(a) {
  const b = $('posBody'), ct = $('posCount');
  ct.textContent = (a ? a.length : 0) + ' OPEN';
  b.innerHTML = !a || !a.length ? '<div class="empty">NO OPEN POSITIONS</div>' : a.map(p => {
    const cls = p.unrealized >= 0 ? 'buy' : 'sell';
    const mark = p.markPrice != null ? p.markPrice : p.entryPrice;
    return '<div class="trade-item"><div><span class="' + cls + '">' + (p.outcome === 'UP' ? '▲ UP' : '▼ DOWN') + '</span><div class="dim">' + num(p.shares) + 'sh @ $' + p.entryPrice.toFixed(2) + ' · MARK ' + prc(mark) + '</div></div><div class="' + tone(p.unrealized) + '">' + money(p.unrealized) + '</div></div>';
  }).join('');
}
function renderResults(a) {
  const b = $('resBody'), ct = $('resCount');
  ct.textContent = (a ? a.length : 0) + ' RESOLVED';
  b.innerHTML = !a || !a.length ? '<div class="empty">NO RESOLVED POSITIONS YET</div>' : a.map(r => {
    const side = r.outcome === 'UP' ? '▲ UP' : '▼ DOWN';
    const cls = r.pnl >= 0 ? 'buy' : 'sell';
    return '<div class="result"><div><span class="' + cls + '">' + side + ' ' + (r.exitReason || '') + '</span><div class="dim">' + new Date(r.closedAt).toLocaleTimeString() + ' · ' + num(r.shares) + 'sh @ $' + r.entryPrice.toFixed(2) + ' · ' + (r.won ? 'WIN' : 'LOSS') + '</div></div><div class="' + cls + '">' + money(r.pnl) + '</div></div>';
  }).join('');
}
function renderFeed(a) {
  const b = $('feedBody'), ct = $('feedCount');
  ct.textContent = (a ? a.length : 0) + ' TRADES';
  b.innerHTML = !a || !a.length ? '<div class="empty">NO TRADES YET</div>' : a.map(tr => {
    const isBuy = tr.type === 'BUY';
    const cls = isBuy ? 'buy' : 'sell';
    const side = tr.outcome === 'UP' ? '▲ UP' : '▼ DOWN';
    return '<div class="trade-item"><div><span class="' + cls + '">' + (isBuy ? 'BUY' : (tr.type === 'REFUND' ? '↩' : 'SELL')) + ' ' + side + '</span><div class="dim">' + new Date(tr.timestamp).toLocaleTimeString() + ' · ' + num(tr.shares) + 'sh @ $' + tr.price.toFixed(2) + '</div></div><div class="' + cls + '">' + money(tr.pnl || 0) + '</div></div>';
  }).join('');
}
function renderLogs(a) {
  const b = $('logBody'), ct = $('logCount');
  ct.textContent = (a ? a.length : 0) + ' LINES';
  b.innerHTML = (a || []).slice(-80).map(l => {
    let cls = '';
    if (l.includes('WIN')) cls = 'log-win';
    else if (l.includes('LOSS')) cls = 'log-loss';
    else if (l.includes('💰')) cls = 'log-tp';
    else if (l.includes('🎯') || l.includes('🏁') || l.includes('BUY') || l.includes('🚀') || l.includes('✅')) cls = 'log-info';
    return '<div class="' + cls + '">' + ESC(l) + '</div>';
  }).join('');
  b.scrollTop = b.scrollHeight;
}
function renderConfig(c) {
  if (!c) return;
  const b = $('configBody');
  b.innerHTML = '<div class="mini" style="display:inline-block;margin-right:6px"><div class="label">Ladder</div><div class="value">' + ((c.ladder || []).map(r => '$'+r.price+'×'+r.shares).join(' · ') || '—') + '</div></div>' +
    '<div class="mini" style="display:inline-block"><div class="label">Capital</div><div class="value">' + cash(c.bankroll) + '</div></div>';
}
function renderChart(c) {
  const svg = $('equityChart'), epl = $('equityPeakLabel');
  if (epl) epl.textContent = 'VALUE ' + cash(S.markValue || 0) + ' · PEAK ' + cash(S.peakEquity || 0);
  if (!c || !c.length) { svg.innerHTML = '<text x="350" y="60" text-anchor="middle" fill="#555" font-size="12">No equity data yet</text>'; return; }
  const v = c.map(p => p.equity), lo = Math.min(...v), hi = Math.max(...v), rng = (hi - lo) || 1;
  const W = 700, H = 120, P = 12;
  const pts = c.map((p, i) => [i / Math.max(1, c.length - 1) * W, H - P - (p.equity - lo) / rng * (H - P * 2)]);
  const path = 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' L');
  const last = pts.at(-1) || [0, H / 2];
  const color = S.totalPnl >= 0 ? '#00ff85' : '#ff4a68';
  svg.innerHTML = '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="2.5"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="4" fill="' + color + '"/>';
}
function fullRender(d) {
  Object.assign(S, d);
  $('strategy').textContent = d.strategy || '';
  renderKpi(d);
  renderMarket(d.currentWindow);
  renderLadder(d);
  renderPositions(d.positions);
  renderResults(d.results);
  renderFeed(d.trades);
  renderLogs(d.logs);
  renderConfig(d.config);
  renderChart(d.equityCurve);
}
async function poll() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    const d = await r.json();
    fullRender(d);
  } catch (e) {
    const sp = $('statusPill');
    if (sp) { sp.textContent = '● OFFLINE'; sp.className = 'pill bad'; }
  }
}
setInterval(poll, 700);
poll();
</script></body></html>`;

app.get('/', (_, res) => res.type('html').send(dashboard));

app.listen(port, '0.0.0.0', () => {
  console.log(`PrevWinner Bot listening on :${port}`);
  engine.init().catch(e => console.error('Init:', e.message));
});
