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

app.get('/healthz', (req, res) => res.sendStatus(200));

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Polymarket Bot</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: monospace; background: #0d0d0d; color: #e0e0e0; padding: 16px; font-size: 13px; }
    h2 { color: #00e5ff; margin: 0 0 4px; }
    .dry-banner  { background: #ffd74033; border: 1px solid #ffd740; color: #ffd740;
                   padding: 8px 14px; border-radius: 6px; margin-bottom: 14px; font-size: 13px; font-weight: bold; display: none; }
    .live-banner { background: #ff525233; border: 1px solid #ff5252; color: #ff5252;
                   padding: 8px 14px; border-radius: 6px; margin-bottom: 14px; font-size: 13px; font-weight: bold; display: none; }
    .row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px; min-width: 160px; flex: 1; }
    .card h3 { margin: 0 0 8px; color: #aaa; font-size: 11px; text-transform: uppercase; }
    .big { font-size: 22px; font-weight: bold; color: #fff; }
    .green  { color: #00e676; }
    .red    { color: #ff5252; }
    .yellow { color: #ffd740; }
    .cyan   { color: #00e5ff; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #222; color: #888; padding: 6px 8px; text-align: left; font-size: 11px; }
    td { padding: 5px 8px; border-bottom: 1px solid #222; font-size: 12px; }
    .log-box { background: #111; border: 1px solid #333; border-radius: 6px; padding: 10px;
               height: 300px; overflow-y: auto; font-size: 11px; line-height: 1.6; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: bold; }
    .badge-green  { background: #00e67622; color: #00e676; border: 1px solid #00e676; }
    .badge-yellow { background: #ffd74022; color: #ffd740; border: 1px solid #ffd740; }
    .badge-red    { background: #ff525222; color: #ff5252; border: 1px solid #ff5252; }
    .badge-blue   { background: #00e5ff22; color: #00e5ff; border: 1px solid #00e5ff; }
    .badge-grey   { background: #33333322; color: #888;    border: 1px solid #555; }
    .fire-pip { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 3px; }
    .fire-lit  { background: #00e676; }
    .fire-dark { background: #333; border: 1px solid #555; }
    .section-title { color: #aaa; margin: 0 0 8px; font-size: 12px; }
    .candle-hist { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
    .candle-chip { padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: bold; }
    .candle-green  { background: #00e67622; color: #00e676; border: 1px solid #00e676; }
    .candle-red    { background: #ff525222; color: #ff5252; border: 1px solid #ff5252; }
    .candle-doji   { background: #ffd74022; color: #ffd740; border: 1px solid #ffd740; }
  </style>
</head>
<body>
  <h2>🎯 Polymarket Bot</h2>
  <div class="dry-banner"  id="dry-banner">⚠️ DRY RUN MODE — No real orders are being placed</div>
  <div class="live-banner" id="live-banner">🔴 LIVE MODE — Real money is active</div>

  <!-- Capital row -->
  <div class="row">
    <div class="card">
      <h3>Capital (real-time)</h3>
      <div class="big cyan" id="capital">—</div>
      <div style="font-size:10px;color:#555;margin-top:4px;">start + realized + unrealized</div>
    </div>
    <div class="card">
      <h3>Session P&amp;L</h3>
      <div class="big" id="pnl">—</div>
    </div>
    <div class="card">
      <h3>Realized P&amp;L</h3>
      <div class="big" id="realized">—</div>
    </div>
    <div class="card">
      <h3>Uptime</h3>
      <div class="big" id="uptime">—</div>
    </div>
  </div>

  <!-- Candle history -->
  <h3 class="section-title">CANDLE HISTORY (last 5)</h3>
  <div class="candle-hist" id="candle-hist">—</div>

  <!-- Active markets -->
  <h3 class="section-title">ACTIVE MARKETS</h3>
  <table>
    <thead>
      <tr>
        <th>Pair</th>
        <th>Direction</th>
        <th>Secs In</th>
        <th>Secs Left</th>
        <th>Price (side)</th>
        <th>Shares</th>
        <th>Avg Cost</th>
        <th>Total Cost</th>
        <th>Unrealized</th>
        <th>Fires</th>
        <th>Open Orders</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody id="mkt-body"><tr><td colspan="12" style="color:#555">Waiting for window…</td></tr></tbody>
  </table>

  <!-- Recent trades -->
  <h3 class="section-title">RECENT TRADES</h3>
  <table>
    <thead><tr><th>Time</th><th>Pair</th><th>Side</th><th>Fire#</th><th>Shares</th><th>Price</th><th>Cost</th></tr></thead>
    <tbody id="trade-body"><tr><td colspan="7" style="color:#555">No trades yet</td></tr></tbody>
  </table>

  <!-- Logs -->
  <h3 class="section-title">LOGS</h3>
  <div class="log-box" id="logs"></div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    const fmtS   = s => { const m = Math.floor(s/60), sec = s%60; return m + 'm ' + String(sec).padStart(2,'0') + 's'; };
    const sgn    = v => (v >= 0 ? '+' : '') + v.toFixed(2);

    socket.on('state', s => {
      // Banner
      document.getElementById('dry-banner').style.display  = s.dryRun ? 'block' : 'none';
      document.getElementById('live-banner').style.display = s.dryRun ? 'none'  : 'block';

      // Capital
      const capEl = document.getElementById('capital');
      capEl.textContent = '$' + (s.capital || 0).toFixed(2);

      const pnlEl = document.getElementById('pnl');
      pnlEl.textContent = sgn(s.pnl || 0);
      pnlEl.className   = 'big ' + (s.pnl >= 0 ? 'green' : 'red');

      const realEl = document.getElementById('realized');
      realEl.textContent = sgn(s.realizedPnl || 0);
      realEl.className   = 'big ' + ((s.realizedPnl||0) >= 0 ? 'green' : 'red');

      document.getElementById('uptime').textContent = fmtS(s.uptime || 0);

      // Candle history
      const ch  = s.candleHistory || {};
      const chEl = document.getElementById('candle-hist');
      const parts = [];
      for (const [pair, candles] of Object.entries(ch)) {
        if (!candles || candles.length === 0) continue;
        parts.push('<strong style="color:#aaa">' + pair + ':</strong> ');
        candles.forEach(c => {
          const cls = c.type === 'green' ? 'candle-green' : c.type === 'red' ? 'candle-red' : 'candle-doji';
          parts.push('<span class="candle-chip ' + cls + '">' + c.type.toUpperCase() + '</span>');
        });
      }
      chEl.innerHTML = parts.length > 0 ? parts.join(' ') : '<span style="color:#555">No candle data yet</span>';

      // Markets
      const mb = document.getElementById('mkt-body');
      if (s.markets && s.markets.length > 0) {
        mb.innerHTML = s.markets.map(m => {
          // Direction badge
          const dirBadge = m.direction === 'up'
            ? '<span class="badge badge-green">▲ UP</span>'
            : '<span class="badge badge-red">▼ DOWN</span>';

          // Fire pips (4 total)
          const pips = [0,1,2,3].map(i =>
            '<span class="fire-pip ' + (i < m.firedCount ? 'fire-lit' : 'fire-dark') + '"></span>'
          ).join('');

          const price = m.direction === 'up' ? m.upPrice : m.downPrice;
          const priceCol = price >= 0.5 ? 'red' : 'green';

          const unrCol = (m.unrealized||0) >= 0 ? 'green' : 'red';

          const statusBadge = m.done
            ? '<span class="badge badge-grey">DONE</span>'
            : m.forceSellDone
              ? '<span class="badge badge-yellow">SOLD</span>'
              : '<span class="badge badge-green">LIVE</span>';

          return '<tr>' +
            '<td>' + m.pair + (m.dryRun ? ' <span class="badge badge-blue">DRY</span>' : '') + '</td>' +
            '<td>' + dirBadge + '</td>' +
            '<td>' + m.secsIn + 's</td>' +
            '<td>' + m.secsLeft + 's</td>' +
            '<td class="' + priceCol + '">' + (price||0).toFixed(4) + '</td>' +
            '<td class="' + (m.shares>0?'green':'') + '">' + m.shares + 'sh</td>' +
            '<td>' + (m.avgCost||0).toFixed(4) + '</td>' +
            '<td>$' + (m.totalCost||0).toFixed(2) + '</td>' +
            '<td class="' + unrCol + '">' + sgn(m.unrealized||0) + '</td>' +
            '<td>' + pips + ' ' + m.firedCount + '/4</td>' +
            '<td class="' + (m.openOrders>0?'yellow':'') + '">' + m.openOrders + '</td>' +
            '<td>' + statusBadge + '</td>' +
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
          '<td>#' + (t.fire||'?') + '</td>' +
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
          const col = l.includes('❌')||l.includes('🚨')||l.includes('📉') ? '#ff5252'
                    : l.includes('✅')||l.includes('💰')||l.includes('🏆') ? '#00e676'
                    : l.includes('📥')||l.includes('⏱')||l.includes('[DRY')||l.includes('🎯') ? '#ffd740'
                    : l.includes('🕯️') ? '#00e5ff'
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
