'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./polymarket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/api/status', (_, res) => {
  try { res.json(bot.getStatus()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/pause', (_, res) => {
  try { res.json(bot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/resume', (_, res) => {
  try { res.json(bot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(bot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🎯 BTC Periodic Resting Limit Buy Bot</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #1c2333; --border: #30363d;
    --text: #e6edf3; --muted: #7d8590; --cyan: #58a6ff; --green: #3fb950;
    --red: #f85149; --yellow: #d29922; --purple: #bc8cff; --gold: #e3b341;
    --orange: #f0883e;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Fira Code', 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; }
  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 20px; font-weight: bold; color: var(--gold); }
  .logo span { color: var(--cyan); }
  .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
  .mode-dry { background: #d2992222; color: var(--yellow); border: 1px solid var(--yellow); }
  .mode-live { background: #f8514922; color: var(--red); border: 1px solid var(--red); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .toolbar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: var(--cyan); color: #0d1117; border: none; padding: 8px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 11px; }
  .toolbar button.pause { background: var(--yellow); }
  .toolbar button.resume { background: var(--green); }
  .toolbar button.live-toggle { background: var(--red); color: #fff; }
  .toolbar button.live-toggle.is-live { background: var(--muted); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; padding: 14px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .stat-val { font-size: 18px; font-weight: bold; }
  .stat-sub { font-size: 9px; color: var(--muted); margin-top: 2px; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 14px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .market-panel { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin: 0 20px 14px; }
  .market-hdr { background: var(--bg3); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .market-sym { font-size: 16px; font-weight: bold; }
  .phase-badge { padding: 3px 12px; border-radius: 14px; font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .phase-placing { background: #58a6ff22; color: var(--cyan); border: 1px solid var(--cyan); }
  .phase-holding { background: #d2992222; color: var(--yellow); border: 1px solid var(--yellow); }
  .phase-closed { background: #7d859022; color: var(--muted); border: 1px solid var(--muted); }
  .phase-loading { background: #f0883e22; color: var(--orange); border: 1px solid var(--orange); }
  .market-timer { font-size: 13px; font-weight: bold; color: var(--cyan); }
  .market-body { padding: 14px 16px; }
  .price-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
  .price-box { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .price-box-hdr { font-size: 11px; font-weight: bold; margin-bottom: 6px; }
  .price-box-hdr.up { color: var(--green); }
  .price-box-hdr.down { color: var(--red); }
  .price-row { display: flex; justify-content: space-between; padding: 2px 0; font-size: 11px; }
  .price-key { color: var(--muted); }
  .price-val { font-weight: bold; }
  .mid-val { font-size: 16px; font-weight: bold; color: var(--gold); }
  .orders-section { margin-top: 10px; }
  .orders-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .orders-summary { display: flex; gap: 12px; margin-bottom: 8px; font-size: 10px; }
  .orders-summary span { padding: 2px 8px; border-radius: 10px; }
  .count-resting { background: #58a6ff22; color: var(--cyan); border: 1px solid #58a6ff44; }
  .count-filled { background: #3fb95022; color: var(--green); border: 1px solid #3fb95044; }
  .count-cancelled { background: #7d859022; color: var(--muted); border: 1px solid #7d859044; }
  .orders-table { width: 100%; border-collapse: collapse; font-size: 10px; }
  .orders-table th { text-align: left; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: 1px; padding: 4px 6px; border-bottom: 1px solid var(--border); }
  .orders-table td { padding: 4px 6px; border-bottom: 1px solid #21262d; }
  .state-resting { color: var(--cyan); }
  .state-filled { color: var(--green); }
  .state-cancelled { color: var(--muted); }
  .side-up { color: var(--green); }
  .side-down { color: var(--red); }
  .empty { color: var(--muted); text-align: center; padding: 20px; font-style: italic; }
  .config-row { display: flex; gap: 16px; padding: 4px 0; font-size: 10px; }
  .config-row .label { color: var(--muted); }
  .config-row .value { color: var(--cyan); font-weight: bold; }
  table.trades { width: 100%; border-collapse: collapse; font-size: 10px; }
  table.trades th { text-align: left; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: 1px; padding: 4px 6px; border-bottom: 1px solid var(--border); }
  table.trades td { padding: 4px 6px; border-bottom: 1px solid #21262d; }
  #logs { max-height: 200px; overflow-y: auto; font-size: 10px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .log-line { padding: 1px 0; }
  .connected { color: var(--green); font-size: 10px; }
  .disconnected { color: var(--red); font-size: 10px; }
  .scroll-wrap { max-height: 160px; overflow-y: auto; }
  .scroll-wrap::-webkit-scrollbar { width: 4px; }
  .scroll-wrap::-webkit-scrollbar-track { background: transparent; }
  .scroll-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">🎯 <span>BTC</span> Resting Limit Bot</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>

  <div class="toolbar">
    <button class="pause" onclick="fetch('/api/pause',{method:'POST'}).then(r=>r.json()).then(d=>{toast(d.ok?'Paused':'Error')})">⏸ Pause</button>
    <button class="resume" onclick="fetch('/api/resume',{method:'POST'}).then(r=>r.json()).then(d=>{toast(d.ok?'Resumed':'Error')})">▶ Resume</button>
    <button class="live-toggle" id="liveBtn" onclick="toggleLive()">🔴 Go Live</button>
    <span id="conn" class="disconnected">⏳ connecting…</span>
  </div>

  <div id="stats" class="stats-row"></div>

  <div class="market-panel" id="market-panel">
    <div class="empty">Loading market…</div>
  </div>

  <div class="section">
    <div class="section-hdr">Config</div>
    <div id="config-box"></div>
  </div>

  <div class="section">
    <div class="section-hdr">Trade Log</div>
    <div class="scroll-wrap">
      <table class="trades"><thead><tr><th>Time</th><th>Side</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&L</th></tr></thead><tbody id="trade-body"></tbody></table>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr">Logs</div>
    <div id="logs"></div>
  </div>

  <div style="padding:10px 20px;text-align:center;color:var(--muted);font-size:9px;">
    Last update: <span id="last-update">—</span>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
let isLive = false;

socket.on('connect', () => { document.getElementById('conn').innerHTML = '<span class="connected">● Connected</span>'; });
socket.on('disconnect', () => { document.getElementById('conn').innerHTML = '<span class="disconnected">● Disconnected</span>'; });

function fmtSecs(s) { if (s == null) return '—'; const m=Math.floor(s/60), sec=s%60; return m+':'+String(sec).padStart(2,'0'); }
function fmtUptime(s) { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?h+'h '+m+'m':m+'m'; }
function sgn(n) { return n >= 0 ? '+$'+n.toFixed(2) : '-$'+Math.abs(n).toFixed(2); }
function pClass(n) { return n >= 0 ? 'pnl-pos' : 'pnl-neg'; }
function toast(msg) { const el=document.createElement('div'); el.textContent=msg; el.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1c2333;color:#58a6ff;padding:8px 20px;border-radius:8px;border:1px solid #58a6ff;font-size:12px;z-index:999'; document.body.appendChild(el); setTimeout(()=>el.remove(),2000); }

function toggleLive() {
  const want = !isLive;
  fetch('/api/set-mode', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ live: want }) })
    .then(r => r.json()).then(d => { isLive = !d.dryRun; toast(want ? '🔴 LIVE MODE' : '🟡 DEMO MODE'); });
}

socket.on('state', s => {
  document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
  isLive = !s.dryRun;

  const modeBadge = document.getElementById('mode-badge');
  if (s.dryRun) { modeBadge.textContent = 'DEMO'; modeBadge.className = 'mode-badge mode-dry'; }
  else { modeBadge.textContent = 'LIVE'; modeBadge.className = 'mode-badge mode-live'; }

  const liveBtn = document.getElementById('liveBtn');
  if (s.dryRun) { liveBtn.textContent = '🔴 Go Live'; liveBtn.className = 'live-toggle'; }
  else { liveBtn.textContent = '🟡 Go Demo'; liveBtn.className = 'live-toggle is-live'; }

  const pnlCls = pClass(s.totalPnl);
  document.getElementById('stats').innerHTML =
    '<div class="stat"><div class="stat-label">Equity</div><div class="stat-val">$'+s.totalMarkValue.toFixed(2)+'</div><div class="stat-sub">capital $'+s.totalCapital+'</div></div>'+
    '<div class="stat"><div class="stat-label">Bankroll</div><div class="stat-val">$'+s.totalBankroll.toFixed(2)+'</div><div class="stat-sub">cash available</div></div>'+
    '<div class="stat"><div class="stat-label">P&L</div><div class="stat-val '+pnlCls+'">'+sgn(s.totalPnl)+'</div><div class="stat-sub">realized '+sgn(s.totalRealizedPnl)+'</div></div>'+
    '<div class="stat"><div class="stat-label">Unrealized</div><div class="stat-val '+pClass(s.totalUnrealizedPnl)+'">'+sgn(s.totalUnrealizedPnl)+'</div><div class="stat-sub">open positions</div></div>'+
    '<div class="stat"><div class="stat-label">W / L</div><div class="stat-val">'+s.totalWins+' / '+s.totalLosses+'</div><div class="stat-sub">'+(s.winRate != null ? s.winRate+'% win' : '—')+'</div></div>'+
    '<div class="stat"><div class="stat-label">Uptime</div><div class="stat-val">'+fmtUptime(s.uptime)+'</div></div>';

  const p = s.pairState;
  const mp = document.getElementById('market-panel');
  if (!p) { mp.innerHTML = '<div class="empty">Loading market…</div>'; }
  else {
    const phaseLabel = { placing: 'PLACING ORDERS', holding: 'HOLDING — waiting for fills', closed: 'CLOSED', loading: 'LOADING…' }[p.phase] || p.phase;
    const upMidStr = p.upMid != null ? p.upMid.toFixed(2) : '—';
    const downMidStr = p.downMid != null ? p.downMid.toFixed(2) : '—';

    // Orders table
    let ordersHtml = '';
    if (p.orders && p.orders.length > 0) {
      ordersHtml = '<table class="orders-table"><thead><tr><th>#</th><th>Side</th><th>Limit</th><th>Shares</th><th>State</th><th>Fill</th><th>Cost</th></tr></thead><tbody>';
      p.orders.forEach((o, i) => {
        const stateCls = { resting: 'state-resting', filled: 'state-filled', cancelled: 'state-cancelled' }[o.state] || '';
        ordersHtml += '<tr><td>'+(i+1)+'</td><td class="side-'+o.side.toLowerCase()+'">'+o.side+'</td><td>'+o.limitPrice.toFixed(2)+'</td><td>'+o.shares+'</td><td class="'+stateCls+'">'+o.state.toUpperCase()+'</td><td>'+(o.fillPrice ? o.fillPrice.toFixed(2) : '—')+'</td><td>'+(o.cost ? '$'+o.cost.toFixed(2) : '—')+'</td></tr>';
      });
      ordersHtml += '</tbody></table>';
    } else {
      ordersHtml = '<div class="empty">No orders yet</div>';
    }

    mp.innerHTML =
      '<div class="market-hdr">'+
        '<div class="market-sym">'+p.symbol+'</div>'+
        '<div class="phase-badge phase-'+p.phase+'">'+phaseLabel+'</div>'+
        '<div class="market-timer">'+(p.tradable ? fmtSecs(p.secsToEnd)+' left' : 'loading…')+'</div>'+
      '</div>'+
      '<div class="market-body">'+
        '<div class="price-grid">'+
          '<div class="price-box">'+
            '<div class="price-box-hdr up">⬆ UP</div>'+
            '<div class="price-row"><span class="price-key">Ask</span><span class="price-val">'+(p.upAsk != null ? p.upAsk.toFixed(3) : '—')+'</span></div>'+
            '<div class="price-row"><span class="price-key">Bid</span><span class="price-val">'+(p.upBid != null ? p.upBid.toFixed(3) : '—')+'</span></div>'+
            '<div class="price-row"><span class="price-key">Mid</span><span class="mid-val">'+upMidStr+'</span></div>'+
          '</div>'+
          '<div class="price-box">'+
            '<div class="price-box-hdr down">⬇ DOWN</div>'+
            '<div class="price-row"><span class="price-key">Ask</span><span class="price-val">'+(p.downAsk != null ? p.downAsk.toFixed(3) : '—')+'</span></div>'+
            '<div class="price-row"><span class="price-key">Bid</span><span class="price-val">'+(p.downBid != null ? p.downBid.toFixed(3) : '—')+'</span></div>'+
            '<div class="price-row"><span class="price-key">Mid</span><span class="mid-val">'+downMidStr+'</span></div>'+
          '</div>'+
        '</div>'+
        '<div class="orders-section">'+
          '<div class="orders-hdr">Orders This Window</div>'+
          '<div class="orders-summary">'+
            '<span class="count-resting">Resting: '+p.restingCount+'</span>'+
            '<span class="count-filled">Filled: '+p.filledCount+'</span>'+
            '<span class="count-cancelled">Cancelled: '+p.cancelledCount+'</span>'+
          '</div>'+
          '<div class="scroll-wrap">'+ordersHtml+'</div>'+
        '</div>'+
      '</div>';
  }

  const cfg = s.config;
  if (cfg) {
    document.getElementById('config-box').innerHTML =
      '<div class="config-row"><span class="label">Price Offset:</span><span class="value">'+cfg.priceOffset+'</span>'+
      '<span class="label" style="margin-left:12px">Order Interval:</span><span class="value">'+cfg.orderTickSecs+'s</span>'+
      '<span class="label" style="margin-left:12px">Cutoff:</span><span class="value">'+cfg.orderCutoffSecs+'s</span>'+
      '<span class="label" style="margin-left:12px">Window:</span><span class="value">300s</span></div>'+
      '<div class="config-row"><span class="label">Sizing:</span><span class="value">Before 100s: 20sh if mid&lt;0.50/10sh if mid&ge;0.50 | After 100s: 20sh if mid>0.50/10sh if mid&le;0.50</span></div>';
  }

  const tb = document.getElementById('trade-body');
  if (s.trades && s.trades.length > 0) {
    tb.innerHTML = s.trades.map(t => {
      const pnlStr = (t.profit !== undefined && t.profit !== null) ? sgn(t.profit) : '—';
      const pnlCls = (t.profit !== undefined && t.profit !== null) ? pClass(t.profit) : '';
      const sideColor = t.side === 'BUY' ? 'var(--green)' : ((t.reason||'').includes('RESOLUTION') ? (t.profit >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--cyan)');
      return '<tr><td>'+t.time+'</td>'+
        '<td style="color:'+sideColor+'">'+t.side+(t.outcome?(' <span class="side-'+t.outcome.toLowerCase()+'">'+t.outcome+'</span>'):'')+'</td>'+
        '<td>'+(t.reason||'—')+'</td>'+
        '<td>'+(t.price||0).toFixed(3)+'</td>'+
        '<td>'+(t.shares||0)+'</td>'+
        '<td class="'+pnlCls+'">'+pnlStr+'</td></tr>';
    }).join('');
  } else {
    tb.innerHTML = '<tr><td colspan="6" class="empty">No trades yet</td></tr>';
  }

  const logEl = document.getElementById('logs');
  if (s.logs && s.logs.length > 0) {
    logEl.innerHTML = s.logs.map(l => {
      const col = l.includes('❌')||l.includes('💥') ? '#f85149'
                : l.includes('💰')||l.includes('✅') ? '#3fb950'
                : l.includes('📍') ? '#e3b341'
                : l.includes('🔭')||l.includes('⏰') ? '#58a6ff'
                : l.includes('⚠️') ? '#d29922'
                : l.includes('📊') ? '#bc8cff'
                : '#e6edf3';
      return '<div class="log-line" style="color:'+col+'">'+l+'</div>';
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }
});
</script>
</body>
</html>`);
});

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log(`🎯 BTC Periodic Resting Limit Buy Bot`);
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — demo capital, simulated fills, real API for data');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
