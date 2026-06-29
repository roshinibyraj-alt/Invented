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

// ── Healthcheck ──
app.get('/healthz', (req, res) => res.sendStatus(200));

// ── Dashboard HTML ──
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Polymarket Bot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: monospace; background: #0d0d0d; color: #e0e0e0; padding: 16px; font-size: 13px; }
    h2 { color: #00e5ff; margin: 0 0 4px; }
    .dry-banner { background: #ffd74033; border: 1px solid #ffd740; color: #ffd740;
                  padding: 8px 14px; border-radius: 6px; margin-bottom: 14px;
                  font-size: 13px; font-weight: bold; display: none; }
    .live-banner { background: #ff525233; border: 1px solid #ff5252; color: #ff5252;
                   padding: 8px 14px; border-radius: 6px; margin-bottom: 14px;
                   font-size: 13px; font-weight: bold; display: none; }
    .row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px; min-width: 180px; flex: 1; }
    .card h3 { margin: 0 0 8px; color: #aaa; font-size: 11px; text-transform: uppercase; }
    .big { font-size: 22px; font-weight: bold; color: #fff; }
    .green  { color: #00e676; }
    .red    { color: #ff5252; }
    .yellow { color: #ffd740; }
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
    .badge-blue   { background: #00e5ff22; color: #00e5ff; border: 1px solid #00e5ff; }
  </style>
</head>
<body>
  <h2>🎯 Polymarket Bot</h2>
  <div class="dry-banner"  id="dry-banner">⚠️ DRY RUN MODE — No real orders are being placed</div>
  <div class="live-banner" id="live-banner">🔴 LIVE MODE — Real money is active</div>

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
        <th>UP Orders</th><th>DN Orders</th>
        <th>Cost</th><th>UP</th><th>DN</th>
      </tr>
    </thead>
    <tbody id="mkt-body"><tr><td colspan="12" style="color:#555">Waiting for window…</td></tr></tbody>
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
    const fmt  = v => v !== undefined ? (v >= 0 ? '+' : '') + v.toFixed(2) : '—';
    const fmtS = s => { const m = Math.floor(s/60), sec = s%60; return m + 'm ' + String(sec).padStart(2,'0') + 's'; }

    socket.on('state', s => {
      // DRY RUN banner
      if (s.dryRun) {
        document.getElementById('dry-banner').style.display  = 'block';
        document.getElementById('live-banner').style.display = 'none';
      } else {
        document.getElementById('dry-banner').style.display  = 'none';
        document.getElementById('live-banner').style.display = 'block';
      }

      document.getElementById('bal').textContent = '$' + (s.balance || 0).toFixed(2);
      const pnlEl = document.getElementById('pnl');
      pnlEl.textContent = fmt(s.pnl);
      pnlEl.className   = 'big ' + (s.pnl >= 0 ? 'green' : 'red');
      document.getElementById('uptime').textContent = fmtS(s.uptime || 0);

      // Markets
      const mb = document.getElementById('mkt-body');
      if (s.markets && s.markets.length > 0) {
        mb.innerHTML = s.markets.map(m => {
          const upBadge = m.upDone
            ? '<span class="badge badge-green">DONE</span>'
            : '<span class="badge badge-yellow">LIVE</span>';
          const dnBadge = m.downDone
            ? '<span class="badge badge-green">DONE</span>'
            : '<span class="badge badge-yellow">LIVE</span>';
          const upCol = m.upPrice  < 0.5 ? 'green' : 'red';
          const dnCol = m.downPrice < 0.5 ? 'green' : 'red';
          const upRule = m.upPrice  < 0.5 ? '6sh/25s' : '12sh/50s';
          const dnRule = m.downPrice < 0.5 ? '6sh/25s' : '12sh/50s';
          return '<tr>' +
            '<td>' + m.pair + (m.dryRun ? ' <span class="badge badge-blue">DRY</span>' : '') + '</td>' +
            '<td>' + m.secsIn + 's</td>' +
            '<td>' + m.secsLeft + 's</td>' +
            '<td class="' + upCol + '">' + (m.upPrice||0).toFixed(3) + ' <small style="color:#555">' + upRule + '</small></td>' +
            '<td class="' + dnCol + '">' + (m.downPrice||0).toFixed(3) + ' <small style="color:#555">' + dnRule + '</small></td>' +
            '<td class="' + (m.upShares>0?'green':'') + '">' + m.upShares + 'sh</td>' +
            '<td class="' + (m.downShares>0?'green':'') + '">' + m.downShares + 'sh</td>' +
            '<td class="' + (m.upOpenOrders>0?'yellow':'') + '">' + m.upOpenOrders + ' open</td>' +
            '<td class="' + (m.dnOpenOrders>0?'yellow':'') + '">' + m.dnOpenOrders + ' open</td>' +
            '<td>$' + (m.totalCost||0).toFixed(2) + '</td>' +
            '<td>' + upBadge + '</td>' +
            '<td>' + dnBadge + '</td>' +
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
                    : l.includes('✅')||l.includes('💰')||l.includes('🎯') ? '#00e676'
                    : l.includes('📥')||l.includes('⏱')||l.includes('[DRY') ? '#ffd740'
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

console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN MODE — no real orders will be placed');
else         console.log('🔴 LIVE MODE — real money trading active');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Bot dashboard on http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
