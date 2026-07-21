'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./polymarket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

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
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>🪜 Grid Ladder Bot — BTC/ETH 15m</title>
<style>
  :root {
    --bg:#0b0e13; --panel:#0f141c; --border:#1c2430; --muted:#7a8699; --text:#dfe6ee;
    --cyan:#00d4ff; --green:#00e676; --red:#ff4757; --yellow:#ffd740; --orange:#ff9f0a; --purple:#9333ea;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:13px; }
  .topbar { display:flex; align-items:center; gap:10px; padding:10px 14px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
  .logo { font-weight:700; font-size:15px; }
  .logo span { color:var(--cyan); }
  .mode-badge { padding:3px 8px; border-radius:5px; font-size:10px; font-weight:700; letter-spacing:.03em; }
  .mode-dry { background:#3a3320; color:var(--yellow); }
  .mode-live { background:#3a1f22; color:var(--red); }
  .spacer { flex:1; }
  button { background:#182030; color:var(--text); border:1px solid #2a3548; border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; }
  button:hover { background:#212c40; }
  .stats-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:1px; background:var(--border); }
  .stat { background:var(--panel); padding:10px 12px; }
  .stat-label { font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; margin-bottom:3px; }
  .stat-val { font-size:16px; font-weight:700; }
  .pnl-pos { color:var(--green); } .pnl-neg { color:var(--red); }
  .section { padding:14px; }
  .section-hdr { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px; }
  .ladder-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; }
  .ladder-card { background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  .ladder-hdr { display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-bottom:1px solid var(--border); }
  .ladder-title { font-weight:700; font-size:13px; }
  .ladder-title.up { color:var(--green); }
  .ladder-title.down { color:var(--red); }
  .ladder-sub { font-size:10px; color:var(--muted); }
  .ladder-price { font-size:12px; color:var(--cyan); }
  .ladder-cap { font-size:10px; padding:2px 6px; border-radius:4px; background:#182030; color:var(--muted); }
  .ladder-cap.full { background:#3a1f22; color:var(--red); }
  .levels { max-height:340px; overflow-y:auto; }
  .level-row { display:grid; grid-template-columns:50px 1fr 60px 50px; gap:6px; align-items:center; padding:4px 12px; font-size:11px; border-bottom:1px solid #12161e; }
  .level-price { font-weight:600; }
  .level-bar { height:6px; border-radius:3px; background:#12161e; overflow:hidden; }
  .level-bar-fill { height:100%; }
  .level-state-idle .level-bar-fill { width:0%; }
  .level-state-idle .level-price { color:#556072; }
  .level-state-waiting_buy .level-bar-fill { width:40%; background:var(--yellow); }
  .level-state-waiting_buy .level-price { color:var(--yellow); }
  .level-state-holding .level-bar-fill { width:100%; background:var(--green); }
  .level-state-holding .level-price { color:var(--green); }
  .level-tp { color:var(--muted); font-size:10px; text-align:right; }
  .level-tag { font-size:9px; text-align:right; color:var(--muted); }
  .tbl-wrap { max-height:340px; overflow-y:auto; border:1px solid var(--border); border-radius:8px; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { text-align:left; padding:6px 8px; color:var(--muted); background:var(--panel); position:sticky; top:0; font-weight:600; }
  td { padding:6px 8px; border-top:1px solid #161d28; }
  .empty { padding:20px; text-align:center; color:#556072; }
  .logs-wrap { max-height:340px; overflow-y:auto; background:#0a0d12; border:1px solid var(--border); border-radius:8px; padding:8px; font-family:ui-monospace,monospace; font-size:11px; line-height:1.6; }
  .bottom-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; padding:0 14px 14px; }
  @media (max-width:800px) { .bottom-grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
  <div class="topbar">
    <div class="logo">🪜 <span>GRID LADDER</span> BOT — BTC/ETH 15m</div>
    <div id="mode-badge" class="mode-badge ${bot.getStatus().dryRun ? 'mode-dry' : 'mode-live'}">${bot.getStatus().dryRun ? 'DEMO' : '🔴 LIVE'}</div>
    <div class="spacer"></div>
    <button id="pause-btn">Pause</button>
    <button id="resume-btn">Resume</button>
    <button id="mode-toggle-btn">Switch to LIVE</button>
  </div>

  <div class="stats-row">
    <div class="stat"><div class="stat-label">Bankroll</div><div class="stat-val" id="bankroll">$0.00</div></div>
    <div class="stat"><div class="stat-label">Mark Value</div><div class="stat-val" id="mark-value">$0.00</div></div>
    <div class="stat"><div class="stat-label">Total P&amp;L</div><div class="stat-val" id="total-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Realized</div><div class="stat-val" id="realized-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val" id="win-rate">—</div></div>
    <div class="stat"><div class="stat-label">Open Positions</div><div class="stat-val" id="open-count">0</div></div>
    <div class="stat"><div class="stat-label">Window Ends</div><div class="stat-val" id="secs-to-end">—</div></div>
    <div class="stat"><div class="stat-label">Entry Cutoff</div><div class="stat-val" id="secs-to-cutoff">—</div></div>
  </div>

  <div class="section">
    <div class="section-hdr">Ladders</div>
    <div class="ladder-grid" id="ladder-grid"><div class="empty">Loading…</div></div>
  </div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr">Trades</div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Time</th><th>Ladder</th><th>Side</th><th>Reason</th><th>Price</th><th>Shares</th><th>P&amp;L</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="7" class="empty">No trades yet</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr">Logs</div>
      <div class="logs-wrap" id="logs"></div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  function sgn(n) { n = n || 0; return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
  function pClass(n) { return (n || 0) >= 0 ? 'pnl-pos' : 'pnl-neg'; }
  function fmtSecs(s) { if (s === null || s === undefined) return '—'; const m = Math.floor(s/60), ss = s%60; return m+'m '+String(ss).padStart(2,'0')+'s'; }

  document.getElementById('pause-btn').addEventListener('click', async () => { await fetch('/api/pause', { method: 'POST' }); });
  document.getElementById('resume-btn').addEventListener('click', async () => { await fetch('/api/resume', { method: 'POST' }); });
  document.getElementById('mode-toggle-btn').addEventListener('click', async () => {
    const btn = document.getElementById('mode-toggle-btn');
    const goingLive = btn.textContent.includes('LIVE');
    if (goingLive && !confirm('Switch to LIVE mode? This places real orders with real money.')) return;
    if (!goingLive && !confirm('Switch back to DEMO mode?')) return;
    const r = await fetch('/api/set-mode', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ live: goingLive }) });
    const data = await r.json();
    updateModeUI(data.dryRun);
  });
  function updateModeUI(dryRun) {
    document.getElementById('mode-badge').className = 'mode-badge ' + (dryRun ? 'mode-dry' : 'mode-live');
    document.getElementById('mode-badge').textContent = dryRun ? 'DEMO' : '🔴 LIVE';
    document.getElementById('mode-toggle-btn').textContent = dryRun ? 'Switch to LIVE' : 'Switch to DEMO';
  }

  const STATE_LABEL = { IDLE: 'idle', WAITING_BUY: 'resting buy', HOLDING: 'holding \u2192 TP resting' };

  socket.on('state', (s) => {
    updateModeUI(s.dryRun);
    document.getElementById('bankroll').textContent = '$'+(s.bankroll||0).toFixed(2);
    document.getElementById('mark-value').textContent = '$'+(s.markValue||0).toFixed(2);
    document.getElementById('total-pnl').textContent = sgn(s.totalPnl);
    document.getElementById('total-pnl').className = 'stat-val ' + pClass(s.totalPnl);
    document.getElementById('realized-pnl').textContent = sgn(s.realizedPnl);
    document.getElementById('realized-pnl').className = 'stat-val ' + pClass(s.realizedPnl);
    document.getElementById('win-rate').textContent = s.winRate === null ? '—' : s.winRate.toFixed(1)+'%';
    document.getElementById('open-count').textContent = s.openPositionCount||0;
    document.getElementById('secs-to-end').textContent = fmtSecs(s.secsToEnd);
    document.getElementById('secs-to-cutoff').textContent = s.secsToEntryCutoff > 0 ? fmtSecs(s.secsToEntryCutoff) : 'closed';

    const grid = document.getElementById('ladder-grid');
    if (!s.ladders || !s.ladders.length) {
      grid.innerHTML = '<div class="empty">Loading…</div>';
    } else {
      grid.innerHTML = s.ladders.map(l => {
        const totalExposure = l.holdingCount + l.waitingCount;
        const capCls = totalExposure >= l.maxOpen ? 'ladder-cap full' : 'ladder-cap';
        const levelsHtml = l.levels.slice().reverse().map(lv => {
          const stCls = 'level-state-' + lv.state.toLowerCase();
          const tag = lv.state === 'IDLE' ? '' : (lv.state === 'WAITING_BUY' ? 'resting' : (lv.position ? lv.position.shares+'sh' : ''));
          return '<div class="level-row '+stCls+'">'+
            '<div class="level-price">'+lv.price.toFixed(2)+'</div>'+
            '<div class="level-bar"><div class="level-bar-fill"></div></div>'+
            '<div class="level-tp">tp '+lv.tpPrice.toFixed(2)+'</div>'+
            '<div class="level-tag">'+tag+'</div>'+
          '</div>';
        }).join('');
        return '<div class="ladder-card">'+
          '<div class="ladder-hdr">'+
            '<div><div class="ladder-title '+l.side.toLowerCase()+'">'+l.symbol+' '+l.side+'</div><div class="ladder-sub">'+l.range.min.toFixed(2)+'\u2013'+l.range.max.toFixed(2)+' \u00b7 ask '+(l.ask?.toFixed(2)||'\u2014')+' / bid '+(l.bid?.toFixed(2)||'\u2014')+'</div></div>'+
            '<div class="'+capCls+'">'+totalExposure+'/'+l.maxOpen+'</div>'+
          '</div>'+
          '<div class="levels">'+levelsHtml+'</div>'+
        '</div>';
      }).join('');
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '\u2014';
        const pnlCls = (t.profit !== undefined) ? pClass(t.profit) : '';
        const sideColor = t.side === 'BUY' ? '#ffd740' : (t.reason === 'TP' ? '#00e676' : '#00d4ff');
        return '<tr><td>'+t.time+'</td><td>'+(t.ladder||'\u2014')+'</td>'+
          '<td style="color:'+sideColor+'">'+t.side+'</td>'+
          '<td>'+(t.reason||'ENTRY')+'</td>'+
          '<td>'+(t.price||0).toFixed(3)+'</td>'+
          '<td>'+(t.shares||0)+'</td>'+
          '<td class="'+pnlCls+'">'+pnlStr+'</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="7" class="empty">No trades yet</td></tr>';
    }

    const logsEl = document.getElementById('logs');
    if (s.logs && s.logs.length) {
      logsEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('💥') ? '#ff4757'
                  : l.includes('💰')||l.includes('✅') ? '#00e676'
                  : l.includes('🎯') ? '#ffd740'
                  : l.includes('🔭') ? '#9333ea'
                  : l.includes('⚠️') ? '#ff9f0a'
                  : '#4a6080';
        return '<div style="color:'+col+'">'+l.replace(/</g,'&lt;')+'</div>';
      }).join('');
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  });
</script>
</body>
</html>`);
});

io.on('connection', (socket) => {
  try { socket.emit('state', bot.getStatus()); } catch (_) {}
});

const privateKey = process.env.PRIVATE_KEY || '';
bot.init(privateKey, (event, payload) => io.emit(event, payload), (line) => console.log(line))
  .then(() => {
    server.listen(PORT, () => console.log(`🪜 Grid Ladder Bot dashboard on http://localhost:${PORT}`));
  })
  .catch(e => { console.error('Fatal init error:', e); process.exit(1); });
