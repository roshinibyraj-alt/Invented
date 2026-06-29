'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const bot       = require('./polymarket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

// ── Dashboard HTML ──
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Sniper Bot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: monospace; background: #0d0d0d; color: #e0e0e0; padding: 16px; font-size: 13px; }
    h2 { color: #00e5ff; margin: 0 0 12px; }
    .row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px; min-width: 180px; flex: 1; }
    .card h3 { margin: 0 0 8px; color: #aaa; font-size: 11px; text-transform: uppercase; }
    .big { font-size: 22px; font-weight: bold; color: #fff; }
    .green { color: #00e676; }
    .red   { color: #ff5252; }
    .yellow{ color: #ffd740; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #222; color: #888; padding: 6px 8px; text-align: left; font-size: 11px; }
    td { padding: 5px 8px; border-bottom: 1px solid #222; font-size: 12px; }
    .log-box { background: #111; border: 1px solid #333; border-radius: 6px; padding: 10px;
               height: 280px; overflow-y: auto; font-size: 11px; line-height: 1.6; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: bold; }
    .badge-green  { background: #00e67622; color: #00e676; border: 1px solid #00e676; }
    .badge-yellow { background: #ffd74022; color: #ffd740; border: 1px solid #ffd740; }
    .badge-red    { background: #ff525222; color: #ff5252; border: 1px solid #ff5252; }
    .badge-grey   { background: #33333322; color: #888;    border: 1px solid #555; }
  </style>
</head>
<body>
  <h2>🎯 Polymarket Sniper Bot</h2>

  <div class="row">
    <div class="card">
      <h3>Balance</h3>
      <div class="big" id="bal">—</div>
    </div>
    <div class="card">
      <h3>Session PnL</h3>
      <div class="big" id="pnl">—</div>
    </div>
    <div class="card">
      <h3>Uptime</h3>
      <div class="big" id="uptime">—</div>
    </div>
  </div>

  <h3 style="color:#aaa;margin:0 0 8px;font-size:12px;">ACTIVE MARKETS</h3>
  <table>
    <thead>
      <tr>
        <th>Pair</th><th>Secs In</th><th>Secs Left</th>
        <th>UP Price</th><th>DN Price</th>
        <th>UP Shares</th><th>DN Shares</th>
        <th>Cost</th><th>Status</th>
      </tr>
    </thead>
    <tbody id="mkt-body"><tr><td colspan="9" style="color:#555">Waiting for window…</td></tr></tbody>
  </table>

  <h3 style="color:#aaa;margin:0 0 8px;font-size:12px;">RECENT TRADES</h3>
  <table>
    <thead><tr><th>Time</th><th>Pair</th><th>Side</th><th>Shares</th><th>Price</th><th>Cost</th></tr></thead>
    <tbody id="trade-body"><tr><td colspan="6" style="color:#555">No trades yet</td></tr></tbody>
  </table>

  <h3 style="color:#aaa;margin:0 0 8px;font-size:12px;">LOGS</h3>
  <div class="log-box" id="logs"></div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const fmt = v => v !== undefined ? (v >= 0 ? '+' : '') + v.toFixed(2) : '—';
    const fmtS = s => { const m = Math.floor(s/60), sec = s%60; return m + 'm ' + String(sec).padStart(2,'0') + 's'; }

    socket.on('state', s => {
      document.getElementById('bal').textContent    = '$' + (s.balance || 0).toFixed(2);
      const pnlEl = document.getElementById('pnl');
      pnlEl.textContent = fmt(s.pnl);
      pnlEl.className   = 'big ' + (s.pnl >= 0 ? 'green' : 'red');
      document.getElementById('uptime').textContent = fmtS(s.uptime || 0);

      // Markets
      const mb = document.getElementById('mkt-body');
      if (s.markets && s.markets.length > 0) {
        mb.innerHTML = s.markets.map(m => {
          let badge = '';
          if (m.done && m.nuking)   badge = '<span class="badge badge-red">NUKED</span>';
          else if (m.done)          badge = '<span class="badge badge-green">DONE</span>';
          else if (m.merging)       badge = '<span class="badge badge-green">CASHING OUT</span>';
          else if (m.nuking)        badge = '<span class="badge badge-red">FORCE SELL</span>';
          else if (m.secsLeft <= 0) badge = '<span class="badge badge-grey">EXPIRED</span>';
          else                      badge = '<span class="badge badge-yellow">LIVE</span>';
          const upCol  = m.upPrice  < 0.5  ? 'green' : 'red';
          const dnCol  = m.downPrice > 0.5 ? 'green' : 'red';
          return '<tr>' +
            '<td>' + m.pair + '</td>' +
            '<td>' + m.secsIn + 's</td>' +
            '<td>' + m.secsLeft + 's</td>' +
            '<td class="' + upCol + '">' + (m.upPrice||0).toFixed(3) + '</td>' +
            '<td class="' + dnCol + '">' + (m.downPrice||0).toFixed(3) + '</td>' +
            '<td class="' + (m.upShares>0?'green':'') + '">' + m.upShares + '/6</td>' +
            '<td class="' + (m.downShares>0?'green':'') + '">' + m.downShares + '/6</td>' +
            '<td>$' + (m.totalCost||0).toFixed(2) + '</td>' +
            '<td>' + badge + '</td>' +
            '</tr>';
        }).join('');
      }

      // Trades
      const tb = document.getElementById('trade-body');
      if (s.trades && s.trades.length > 0) {
        tb.innerHTML = s.trades.slice().reverse().map(t =>
          '<tr>' +
          '<td>' + t.time + '</td>' +
          '<td>' + t.pair + '</td>' +
          '<td class="' + (t.side==='UP'?'green':'yellow') + '">' + t.side + '</td>' +
          '<td>' + t.shares + '</td>' +
          '<td>' + (t.price||0).toFixed(3) + '</td>' +
          '<td>$' + (t.cost||0).toFixed(2) + '</td>' +
          '</tr>'
        ).join('');
      }

      // Logs
      const logEl = document.getElementById('logs');
      if (s.logs && s.logs.length > 0) {
        logEl.innerHTML = s.logs.map(l => {
          const col = l.includes('❌')||l.includes('🚨')||l.includes('🔥') ? '#ff5252'
                    : l.includes('✅')||l.includes('💰') ? '#00e676'
                    : l.includes('📥')||l.includes('⏱') ? '#ffd740'
                    : '#aaa';
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Bot dashboard on http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
