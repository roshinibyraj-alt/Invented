'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./polymarket-opportunist-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

app.get('/healthz', (req, res) => res.sendStatus(200));

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Polymarket Opportunist Bot</title>
  <style>
    :root {
      --bg:      #080c10;
      --bg2:     #0f1419;
      --bg3:     #161d26;
      --border:  #1e2d3d;
      --text:    #c9d1d9;
      --muted:   #4a5568;
      --cyan:    #00d4ff;
      --green:   #00e676;
      --red:     #ff4757;
      --yellow:  #ffd740;
      --purple:  #bf5af2;
      --orange:  #ff9f0a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', monospace;
      background: var(--bg);
      color: var(--text);
      font-size: 12px;
      min-height: 100vh;
    }

    /* ── Header ── */
    .header {
      background: linear-gradient(135deg, #0a1628, #0f1f38);
      border-bottom: 1px solid var(--border);
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .logo { font-size: 20px; font-weight: bold; color: var(--cyan); letter-spacing: 1px; }
    .logo span { color: var(--purple); }
    .strategy-tag {
      font-size: 10px; background: #00d4ff18; color: var(--cyan);
      border: 1px solid #00d4ff44; border-radius: 20px; padding: 3px 10px;
    }
    .mode-badge {
      padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: bold;
    }
    .mode-dry  { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
    .mode-live { background: #ff475722; color: var(--red);    border: 1px solid var(--red); animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.6 } }

    /* ── Stats row ── */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
      padding: 14px 20px;
    }
    .stat {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .stat-val   { font-size: 20px; font-weight: bold; color: #fff; }
    .stat-sub   { font-size: 9px; color: var(--muted); margin-top: 3px; }
    .c-cyan   { color: var(--cyan)   !important; }
    .c-green  { color: var(--green)  !important; }
    .c-red    { color: var(--red)    !important; }
    .c-yellow { color: var(--yellow) !important; }
    .c-purple { color: var(--purple) !important; }

    /* ── Section ── */
    .section { padding: 0 20px 16px; }
    .section-hdr {
      font-size: 10px; color: var(--muted); text-transform: uppercase;
      letter-spacing: 2px; padding: 8px 0 6px;
      display: flex; align-items: center; gap: 8px;
    }
    .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }

    /* ── Market cards ── */
    .markets-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 12px;
    }
    .mkt-card {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .mkt-card.live  { border-color: #00e67633; }
    .mkt-card.done  { border-color: #2a2a2a; opacity: 0.65; }
    .mkt-card.exited { border-color: #ffd74033; }

    .mkt-header {
      padding: 10px 12px;
      background: linear-gradient(135deg, #0f1a2e, #111d30);
      display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;
    }
    .mkt-title { font-size: 11px; color: #ddd; flex: 1; line-height: 1.4; }
    .mkt-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }

    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 9px; font-weight: bold; white-space: nowrap;
    }
    .badge-yes    { background: #00e67622; color: var(--green);  border: 1px solid #00e67644; }
    .badge-no     { background: #ff475722; color: var(--red);    border: 1px solid #ff475744; }
    .badge-live   { background: #00d4ff11; color: var(--cyan);   border: 1px solid #00d4ff44; }
    .badge-done   { background: #22222222; color: var(--muted);  border: 1px solid #333; }
    .badge-exit   { background: #ffd74022; color: var(--yellow); border: 1px solid #ffd74044; }
    .badge-cat    { background: #bf5af222; color: var(--purple); border: 1px solid #bf5af244; font-size: 8px; }
    .badge-dry    { background: #ffd74011; color: var(--yellow); border: 1px solid #ffd74033; }

    .mkt-body  { padding: 10px 12px; }
    .mkt-row   { display: flex; justify-content: space-between; margin-bottom: 5px; }
    .mkt-key   { color: var(--muted); font-size: 10px; }
    .mkt-val   { font-size: 10px; font-weight: bold; }

    /* Progress bar */
    .prog-wrap { background: #1a1a1a; border-radius: 4px; height: 5px; margin: 8px 0; overflow:hidden; }
    .prog-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--cyan), var(--purple)); transition: width 0.3s; }

    /* Signal pills */
    .signals-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .sig-pill {
      font-size: 9px; padding: 2px 7px; border-radius: 8px;
      background: #ffffff08; border: 1px solid #ffffff15; color: #aaa;
    }
    .sig-yes  { background: #00e67611; border-color: #00e67633; color: var(--green); }
    .sig-no   { background: #ff475711; border-color: #ff475733; color: var(--red); }
    .sig-skip { background: #22222222; border-color: #333; color: var(--muted); }

    /* Entries pips */
    .pips { display: flex; gap: 5px; align-items: center; }
    .pip {
      width: 9px; height: 9px; border-radius: 50%;
      background: #333; border: 1px solid #444;
    }
    .pip.lit { background: var(--green); border-color: var(--green); box-shadow: 0 0 4px var(--green); }

    /* ── Trades table ── */
    .tbl { width: 100%; border-collapse: collapse; }
    .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
    .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 11px; }
    .tbl tr:last-child td { border-bottom: none; }
    .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 260px; overflow-y: auto; }

    /* ── Logs ── */
    .log-wrap {
      background: #050810;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      height: 280px;
      overflow-y: auto;
      font-size: 11px;
      line-height: 1.7;
    }

    /* ── Bottom flex ── */
    .bottom-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 0 20px 20px;
    }
    @media (max-width: 700px) { .bottom-grid { grid-template-columns: 1fr; } }

    /* Scan indicator */
    .scan-dot {
      display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      background: var(--cyan); margin-right: 6px;
      animation: blink 1.5s infinite;
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }

    /* Empty state */
    .empty { color: var(--muted); padding: 20px; text-align: center; font-size: 11px; }
  </style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-left">
    <div class="logo">⚡ Poly<span>Opportunist</span></div>
    <div class="strategy-tag">Spread Fade · Liq Momentum · Price Velocity</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="color:var(--muted);font-size:10px">
      <span class="scan-dot"></span><span id="scan-ago">scanning…</span>
    </span>
    <span id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">
      ${DRY_RUN ? '⚠️ DRY RUN' : '🔴 LIVE'}
    </span>
  </div>
</div>

<!-- Stats -->
<div class="stats-row">
  <div class="stat">
    <div class="stat-label">Capital</div>
    <div class="stat-val c-cyan" id="capital">—</div>
    <div class="stat-sub">real-time</div>
  </div>
  <div class="stat">
    <div class="stat-label">Session P&amp;L</div>
    <div class="stat-val" id="pnl">—</div>
    <div class="stat-sub">vs start balance</div>
  </div>
  <div class="stat">
    <div class="stat-label">Realized P&amp;L</div>
    <div class="stat-val" id="realized">—</div>
    <div class="stat-sub">closed positions</div>
  </div>
  <div class="stat">
    <div class="stat-label">Active Markets</div>
    <div class="stat-val c-purple" id="active-count">—</div>
    <div class="stat-sub" id="done-count">— completed</div>
  </div>
  <div class="stat">
    <div class="stat-label">Uptime</div>
    <div class="stat-val" id="uptime">—</div>
    <div class="stat-sub">hh:mm:ss</div>
  </div>
</div>

<!-- Active Markets -->
<div class="section">
  <div class="section-hdr">Active Markets</div>
  <div class="markets-grid" id="markets-grid">
    <div class="empty">🔭 Scanning for opportunities…</div>
  </div>
</div>

<!-- Bottom: Trades + Logs -->
<div class="bottom-grid">
  <div>
    <div class="section-hdr" style="margin: 0 0 8px">Recent Trades</div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Time</th><th>Market</th><th>Cat</th><th>Side</th>
            <th>Entry#</th><th>Shares</th><th>Price</th><th>Cost</th>
          </tr>
        </thead>
        <tbody id="trade-body">
          <tr><td colspan="8" class="empty">No trades yet</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  <div>
    <div class="section-hdr" style="margin: 0 0 8px">Bot Logs</div>
    <div class="log-wrap" id="logs"></div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();

  function fmtTime(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return [h,m,sec].map(v => String(v).padStart(2,'0')).join(':');
  }
  function sgn(v) { return (v >= 0 ? '+' : '') + (v || 0).toFixed(2); }
  function pnlClass(v) { return v >= 0 ? 'c-green' : 'c-red'; }

  socket.on('state', s => {
    // Stats
    document.getElementById('capital').textContent     = '$' + (s.capital || 0).toFixed(2);
    const pnlEl = document.getElementById('pnl');
    pnlEl.textContent = sgn(s.pnl || 0);
    pnlEl.className   = 'stat-val ' + pnlClass(s.pnl);
    const relEl = document.getElementById('realized');
    relEl.textContent = sgn(s.realizedPnl || 0);
    relEl.className   = 'stat-val ' + pnlClass(s.realizedPnl);
    document.getElementById('active-count').textContent = s.activeCount ?? '—';
    document.getElementById('done-count').textContent   = (s.doneCount || 0) + ' completed';
    document.getElementById('uptime').textContent       = fmtTime(s.uptime || 0);
    document.getElementById('scan-ago').textContent     = 'last scan ' + (s.lastScanAgo || 0) + 's ago';

    // Markets grid
    const grid = document.getElementById('markets-grid');
    if (!s.markets || s.markets.length === 0) {
      grid.innerHTML = '<div class="empty">🔭 Scanning for opportunities… (markets ending in 5–60 min)</div>';
    } else {
      grid.innerHTML = s.markets.map(m => {
        const sideClass  = m.side === 'yes' ? 'badge-yes' : 'badge-no';
        const sideLabel  = m.side === 'yes' ? '▲ YES' : '▼ NO';
        const progress   = Math.min(100, Math.round((m.secsIn / 540) * 100));
        const cardClass  = m.done ? 'done' : (m.exitDone ? 'exited' : 'live');
        const statusBadge = m.done
          ? '<span class="badge badge-done">DONE</span>'
          : m.exitDone
            ? '<span class="badge badge-exit">EXITED</span>'
            : '<span class="badge badge-live">LIVE</span>';

        // Signal pills
        const sigPills = (m.signals || '').split(' | ').map(sig => {
          const [name, vote] = sig.split(':');
          if (!name) return '';
          const cls = vote === 'YES' ? 'sig-yes' : vote === 'NO' ? 'sig-no' : 'sig-skip';
          return \`<span class="sig-pill \${cls}">\${name}: \${vote}</span>\`;
        }).join('');

        // Entry pips
        const pips = [0,1,2].map(i =>
          \`<span class="pip \${i < m.firedCount ? 'lit' : ''}"></span>\`
        ).join('');

        const unrealCol = (m.unrealized || 0) >= 0 ? 'c-green' : 'c-red';
        const price = m.side === 'yes' ? m.yesMid : m.noMid;

        return \`<div class="mkt-card \${cardClass}">
          <div class="mkt-header">
            <div class="mkt-title">\${m.label}</div>
            <div class="mkt-badges">
              \${statusBadge}
              <span class="badge \${sideClass}">\${sideLabel}</span>
              <span class="badge badge-cat">\${m.category || '?'}</span>
              \${s.dryRun ? '<span class="badge badge-dry">DRY</span>' : ''}
            </div>
          </div>
          <div class="mkt-body">
            <div class="mkt-row">
              <span class="mkt-key">Window Progress</span>
              <span class="mkt-val">\${m.secsIn}s / 540s (\${m.secsLeft}s left)</span>
            </div>
            <div class="prog-wrap"><div class="prog-fill" style="width:\${progress}%"></div></div>
            <div class="mkt-row">
              <span class="mkt-key">YES mid</span>
              <span class="mkt-val">\${(m.yesMid||0).toFixed(4)}</span>
              <span class="mkt-key">NO mid</span>
              <span class="mkt-val">\${(m.noMid||0).toFixed(4)}</span>
            </div>
            <div class="mkt-row">
              <span class="mkt-key">YES liq</span>
              <span class="mkt-val">$\${m.yesLiq}</span>
              <span class="mkt-key">NO liq</span>
              <span class="mkt-val">$\${m.noLiq}</span>
            </div>
            <div class="mkt-row">
              <span class="mkt-key">Score</span>
              <span class="mkt-val c-cyan">\${m.signalScore > 0 ? '+' : ''}\${m.signalScore}</span>
              <span class="mkt-key">Market ends in</span>
              <span class="mkt-val c-yellow">\${m.minsLeft}m</span>
            </div>
            <div class="mkt-row">
              <span class="mkt-key">Shares</span>
              <span class="mkt-val \${m.shares > 0 ? 'c-green' : ''}">\${m.shares}sh</span>
              <span class="mkt-key">Avg Cost</span>
              <span class="mkt-val">\${(m.avgCost||0).toFixed(4)}</span>
            </div>
            <div class="mkt-row">
              <span class="mkt-key">Total Cost</span>
              <span class="mkt-val">$\${(m.totalCost||0).toFixed(2)}</span>
              <span class="mkt-key">Unrealized</span>
              <span class="mkt-val \${unrealCol}">\${sgn(m.unrealized||0)}</span>
            </div>
            \${m.exitPnl !== null && m.exitPnl !== undefined ? \`
            <div class="mkt-row" style="margin-top:4px;padding-top:4px;border-top:1px solid #1e2d3d">
              <span class="mkt-key">Exit P&amp;L</span>
              <span class="mkt-val \${m.exitPnl >= 0 ? 'c-green' : 'c-red'}">\${sgn(m.exitPnl)}</span>
            </div>\` : ''}
            <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
              <div class="pips">\${pips}</div>
              <span style="font-size:9px;color:var(--muted)">\${m.firedCount}/3 entries | \${m.openOrders} open orders</span>
            </div>
            <div class="signals-row">\${sigPills}</div>
          </div>
        </div>\`;
      }).join('');
    }

    // Trades
    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.slice().reverse().map(t =>
        '<tr>' +
        '<td>' + t.time + '</td>' +
        '<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (t.label||'') + '">' + (t.label||'').slice(0,22) + '</td>' +
        '<td style="color:var(--purple);font-size:9px">' + (t.category||'?') + '</td>' +
        '<td class="' + (t.side==='YES'?'c-green':'c-red') + '">' + t.side + '</td>' +
        '<td style="color:var(--muted)">#' + (t.entryNum||'?') + '</td>' +
        '<td>' + t.shares + '</td>' +
        '<td>' + (t.price||0).toFixed(4) + '</td>' +
        '<td>$' + (t.cost||0).toFixed(2) + '</td>' +
        '</tr>'
      ).join('');
    }

    // Logs
    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌') || l.includes('🚨') || l.includes('📉') ? '#ff4757'
                  : l.includes('✅') || l.includes('💰') || l.includes('🏆') || l.includes('✨') ? '#00e676'
                  : l.includes('📥') || l.includes('⏱') || l.includes('[DRY') || l.includes('🎯') ? '#ffd740'
                  : l.includes('📊') || l.includes('📈') || l.includes('🔭') ? '#00d4ff'
                  : l.includes('⚠️') ? '#ff9f0a'
                  : '#6b7888';
        return '<div style="color:' + col + '">' + l + '</div>';
      }).join('');
    }
  });
</script>
</body>
</html>`);
});

// ── Socket.io ──
const emit = (event, data) => io.emit(event, data);
const slog = (line) => {
  console.log(line);
  io.emit('log', line);
};

// ── Start ──
const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN MODE — no real orders will be placed');
else         console.log('🔴 LIVE MODE — real money trading active');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Opportunist dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
