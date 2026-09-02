'use strict';

const express = require('express');
const { CheapHunterEngine } = require('./engine');

process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));
process.on('uncaughtException', (err) => console.error('[FATAL]', err));

const app = express();
const port = Number(process.env.PORT || 3000);

const engine = new CheapHunterEngine({
  name: 'CandleBot',
  onLog: line => console.log(`[CB] ${line}`),
});

app.disable('x-powered-by');
app.get('/healthz', (_, res) => res.json({ ok: true }));
app.get('/api/status', (_, res) => res.json(engine.buildState()));

const dashboard = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CandleBot — BTC 5m</title>
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
.candle-bar{display:grid;grid-template-columns:auto 1fr 1fr 1fr;gap:8px;align-items:center;margin-bottom:8px}
.candle-signal{border:1px solid var(--line);padding:10px;border-radius:8px;background:#000;text-align:center}
.candle-signal .color{font-size:28px;margin-top:2px}
.candle-signal .color.green{color:var(--up)}.candle-signal .color.red{color:var(--down)}.candle-signal .color.neutral{color:var(--muted)}
.ladder-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin-top:6px}
.ladder-cell{border:1px solid var(--line);padding:6px;border-radius:6px;background:#000;text-align:center;font-size:11px}
.ladder-cell.filled{border-color:var(--up);background:#084b31}.ladder-cell.pending{border-color:var(--line)}
.ladder-price{font-size:13px;margin-top:2px}
.ladder-shares{font-size:9px;color:var(--muted);margin-top:1px}
@media(max-width:860px){.metrics{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}.candle-bar{grid-template-columns:1fr}.ladder-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:480px){body{padding:6px;font-size:13px}h1{font-size:16px}.topbar{grid-template-columns:1fr}.side-price{font-size:28px}.clock{font-size:30px}.ladder-grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<header class="topbar">
<div class="brand"><div class="btc">₿</div><div><h1>CandleBot</h1><div class="sub" id="strategy">LOADING…</div></div></div>
<div class="status"><span id="statusPill" class="pill bad">OFFLINE</span><span id="uptimePill" class="pill blue">00:00:00</span></div>
</header>
<div class="metrics" id="kpiRow"></div>
<div class="candle-bar" id="candleBar"></div>
<div class="two-col">
<div>
<div class="box"><div class="section-head"><span>📊 Market — <span id="windowTitle">WAITING…</span></span></div><div id="marketBody"><div class="empty">Waiting for market…</div></div></div>
<div class="box" style="margin-top:8px"><div class="section-head"><span>📈 Positions</span><span id="posCount" class="dim">0</span></div><div class="list" id="posBody"></div></div>
<div class="box" style="margin-top:8px"><div class="section-head"><span>✅ Resolved</span><span id="resCount" class="dim">0</span></div><div class="list" id="resBody"></div></div>
</div>
<div>
<div class="box"><div class="section-head"><span>📜 Trade Feed</span><span id="feedCount" class="dim">0</span></div><div class="list" id="feedBody" style="max-height:180px"></div></div>
<div class="box" style="margin-top:8px"><div class="section-head"><span>📝 Logs</span><span id="logCount" class="dim">0</span></div><div class="logs" id="logBody"></div></div>
<div class="box" style="margin-top:8px"><div class="section-head"><span>⚙ Config</span></div><div id="configBody"></div></div>
</div>
</div>
<div class="box" style="margin-top:8px"><div class="section-head"><span>📈 Equity Curve</span><span id="equityPeakLabel" class="dim"></span></div><svg class="chart" id="equityChart" viewBox="0 0 700 120" preserveAspectRatio="none"></svg></div>
<script>
const S = {};
function $(id) { return document.getElementById(id); }
function num(n) { return n != null ? Number(n).toLocaleString() : '—'; }
function money(n) { if (n == null) return '—'; return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
function prc(n) { return n != null ? '$' + Number(n).toFixed(2) : '—'; }
function cash(n) { return '$' + Number(n || 0).toFixed(2); }
function pct(n) { return n != null ? n + '%' : '—'; }
function uptime(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0'); }
function tone(v) { return v >= 0 ? 'pos' : 'neg'; }
function ESC(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function renderKpi(d) {
  const html = [
    '<div class="box"><div class="label">Capital</div><div class="value">' + cash(d.bankroll) + '</div><div class="small">Mark ' + cash(d.markValue) + '</div></div>',
    '<div class="box"><div class="label">Realized P&L</div><div class="value ' + (d.realizedPnl >= 0 ? 'pos' : 'neg') + '">' + money(d.realizedPnl) + '</div><div class="small">Fees ' + cash(d.totalFeesPaid) + '</div></div>',
    '<div class="box"><div class="label">Unrealized</div><div class="value ' + (d.unrealizedPnl >= 0 ? 'pos' : 'neg') + '">' + money(d.unrealizedPnl) + '</div></div>',
    '<div class="box"><div class="label">Total P&L</div><div class="value ' + (d.totalPnl >= 0 ? 'pos' : 'neg') + '">' + money(d.totalPnl) + '</div><div class="small">Drawdown ' + cash(d.drawdown || 0) + '</div></div>',
  ].join('');
  $('kpiRow').innerHTML = html;
  $('uptimePill').textContent = uptime(d.uptime || 0);
  const sp = $('statusPill');
  if (d.connected) { sp.textContent = '● LIVE'; sp.className = 'pill live'; } else { sp.textContent = '● OFFLINE'; sp.className = 'pill bad'; }
}
function renderCandleBar(d) {
  if (!d) return;
  const c = d.candle || {};
  const lo = d.orderLadder || {};
  let colorClass = 'neutral';
  let colorText = '⏳ WAITING…';
  if (c.lastColor === 'GREEN') { colorClass = 'green'; colorText = '🟢 GREEN (UP)'; }
  else if (c.lastColor === 'RED') { colorClass = 'red'; colorText = '🔴 RED (DOWN)'; }
  else if (c.lastColor === 'NEUTRAL') { colorText = '⚪ NEUTRAL'; }
  const candleInfo = '<div class="candle-signal"><div class="label">BINANCE SIGNAL</div><div class="color ' + colorClass + '">' + colorText + '</div><div class="small" style="margin-top:4px">' + (c.connected ? '🟢 Connected' : '🔴 Disconnected') + '</div></div>';
  const ws = $('windowTitle');
  if (d.currentWindow) ws.textContent = d.currentWindow.slug.replace('btc-updown-5m-', 'Window ');
  let ladderHtml = '';
  if (lo.prices && lo.side && lo.side !== '—') {
    const orders = d.pendingOrders || [];
    const orderMap = {};
    orders.forEach(o => { orderMap[o.limitPrice] = o; });
    ladderHtml = '<div style="grid-column:1/5"><div class="label">ORDER LADDER — BUY ' + lo.side + ' × ' + (lo.sharesPerOrder || 100) + 'sh</div><div class="ladder-grid">' + lo.prices.map(p => {
      const o = orderMap[p];
      const status = o ? o.status : 'WAITING';
      let cls = 'pending';
      let label = '⏳ WAITING';
      if (status === 'FILLED') { cls = 'filled'; label = '✅ FILLED @ $' + (o.fillPrice || 0).toFixed(2); }
      else if (status === 'CANCELLED') { cls = 'pending'; label = '❌ CANCELLED'; }
      else if (status === 'PENDING') { cls = 'pending'; label = '⏳ PENDING'; }
      return '<div class="ladder-cell ' + cls + '"><div class="ladder-price">$' + p.toFixed(2) + '</div><div class="ladder-shares">' + label + '</div></div>';
    }).join('') + '</div></div>';
  } else {
    ladderHtml = '<div style="grid-column:1/5"><div class="empty">No candle signal yet — ladder will appear after signal</div></div>';
  }
  $('candleBar').innerHTML = candleInfo + ladderHtml;
}
function renderMarket(m) {
  const b = $('marketBody');
  if (!m) { b.innerHTML = '<div class="empty">Waiting for market…</div>'; return; }
  b.innerHTML = '<div class="clock">' + m.remaining + 's<small> T+' + m.elapsed + 's</small></div><div class="prices"><div class="side up"><div class="side-name">▲ UP</div><div class="side-price">' + prc(m.up.mid) + '</div><div class="quote-row"><span>Bid</span><span>' + prc(m.up.bid) + '</span></div><div class="quote-row"><span>Ask</span><span>' + prc(m.up.ask) + '</span></div></div><div class="side down"><div class="side-name">▼ DOWN</div><div class="side-price">' + prc(m.down.mid) + '</div><div class="quote-row"><span>Bid</span><span>' + prc(m.down.bid) + '</span></div><div class="quote-row"><span>Ask</span><span>' + prc(m.down.ask) + '</span></div></div></div>';
}
function renderPositions(a) {
  const b = $('posBody'), pb = $('posBox') || b.parentElement;
  if (!a || !a.length) { b.innerHTML = '<div class="empty">No open positions</div>'; return; }
  $('posCount').textContent = a.length;
  b.innerHTML = a.map(p => {
    const cls = p.outcome === 'UP' ? 'buy' : 'sell';
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
    return '<div class="trade-item"><div><span class="' + cls + '">' + (isBuy ? 'BUY' : 'SELL') + ' ' + side + '</span><div class="dim">' + new Date(tr.timestamp).toLocaleTimeString() + ' · ' + num(tr.shares) + 'sh @ $' + tr.price.toFixed(2) + '</div></div><div class="' + cls + '">' + money(tr.pnl || 0) + '</div></div>';
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
    else if (l.includes('🎯') || l.includes('🏁') || l.includes('BUY') || l.includes('🕯️')) cls = 'log-info';
    return '<div class="' + cls + '">' + ESC(l) + '</div>';
  }).join('');
  b.scrollTop = b.scrollHeight;
}
function renderConfig(c) {
  if (!c) return;
  const b = $('configBody');
  b.innerHTML = '<div class="mini" style="display:inline-block;margin-right:6px"><div class="label">Ladder Prices</div><div class="value">' + (c.ladderPrices || []).join(', ') + '</div></div>' +
    '<div class="mini" style="display:inline-block;margin-right:6px"><div class="label">Shares/Order</div><div class="value">' + (c.orderShares || 100) + '</div></div>' +
    '<div class="mini" style="display:inline-block;margin-right:6px"><div class="label">Capital</div><div class="value">' + cash(c.bankroll) + '</div></div>' +
    '<div class="mini" style="display:inline-block"><div class="label">Taker Fee</div><div class="value">' + (c.takerFeeRate != null ? (c.takerFeeRate * 100).toFixed(2) + '%' : '7%') + '</div></div>';
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
  renderCandleBar(d);
  renderMarket(d.currentWindow);
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
  console.log(`CandleBot listening on :${port}`);
  engine.init().catch(e => console.error('Init:', e.message));
});
