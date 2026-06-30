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

app.post('/api/search-match', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });
  try {
    const result = await bot.searchMatch(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/search-markets', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
  try {
    const result = await bot.searchMarkets(q);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/load-market', async (req, res) => {
  const { eventSlug, marketId, side } = req.body || {};
  if (!eventSlug || !side) return res.status(400).json({ ok: false, error: 'Missing eventSlug or side' });
  try {
    const result = await bot.loadMarket({ eventSlug, marketId, side });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>⚽ Draw-NO Block Bot</title>
  <style>
    :root {
      --bg:     #ffffff;
      --bg2:    #f5f7fa;
      --bg3:    #edf0f4;
      --border: #d0d7e2;
      --text:   #1a2535;
      --muted:  #7a8fa8;
      --cyan:   #0099cc;
      --green:  #00a854;
      --red:    #e8304a;
      --yellow: #e6a800;
      --purple: #7c3aed;
      --orange: #d97706;
      --gold:   #b8860b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; }

    .header {
      background: linear-gradient(135deg, #f0f4f8, #e4ecf5);
      border-bottom: 2px solid #0099cc44;
      padding: 14px 20px;
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
    }
    .logo { font-size: 22px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
    .logo span { color: var(--cyan); }
    .match-tag {
      font-size: 11px; background: #00d4ff11; color: var(--cyan);
      border: 1px solid #00d4ff33; border-radius: 20px; padding: 4px 12px;
      max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
    .mode-dry  { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
    .mode-live { background: #ff475722; color: var(--red);    border: 1px solid var(--red); animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

    .search-bar {
      display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap;
    }
    .search-bar input {
      flex: 1; min-width: 240px; background: var(--bg2); border: 1px solid var(--border);
      color: var(--text); padding: 10px 14px; border-radius: 8px; font-family: inherit; font-size: 12px;
    }
    .search-bar input:focus { outline: none; border-color: var(--cyan); }
    .search-bar button {
      background: var(--cyan); color: #001018; border: none; padding: 10px 20px;
      border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px;
    }
    .search-bar button:hover { opacity: .85; }
    .search-status { padding: 6px 20px 0; font-size: 10px; color: var(--muted); min-height: 14px; }
    .search-status.ok  { color: var(--green); }
    .search-status.err { color: var(--red); }

    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 14px 20px; }
    .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .stat-val   { font-size: 20px; font-weight: bold; color: #fff; }
    .stat-sub   { font-size: 9px; color: var(--muted); margin-top: 3px; }

    .match-bar {
      background: var(--bg2); border: 1px solid var(--border);
      margin: 0 20px 14px; border-radius: 10px; padding: 10px 16px;
      display: flex; gap: 24px; flex-wrap: wrap; align-items: center;
    }
    .match-bar-item { font-size: 10px; }
    .match-bar-label { color: var(--muted); margin-right: 6px; }
    .match-bar-val { color: var(--cyan); font-weight: bold; }

    .section { padding: 0 20px 16px; }
    .section-hdr {
      font-size: 10px; color: var(--muted); text-transform: uppercase;
      letter-spacing: 2px; padding: 8px 0 8px;
      display: flex; align-items: center; gap: 8px;
    }
    .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }

    .block-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
    .block-card {
      background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
    }
    .block-card.is-active { border-color: var(--cyan); box-shadow: 0 0 0 1px #00d4ff22; }
    .block-hdr {
      background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center;
    }
    .block-range { font-size: 11px; font-weight: bold; color: #ddd; }
    .block-active-pill {
      font-size: 8px; padding: 1px 7px; border-radius: 6px; background: #00d4ff15; color: var(--cyan); border: 1px solid #00d4ff44;
    }
    .block-dormant-pill {
      font-size: 8px; padding: 1px 7px; border-radius: 6px; background: #ffffff08; color: var(--muted); border: 1px solid #ffffff15;
    }
    .block-body { padding: 8px 12px; }
    .block-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; }
    .block-key { color: var(--muted); }
    .pnl-pos { color: var(--green); }
    .pnl-neg { color: var(--red); }
    .rungs { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 6px; }
    .rung-row { display: flex; justify-content: space-between; font-size: 9px; padding: 2px 0; color: #8aa; }
    .rung-resting { color: var(--yellow); }
    .rung-filled { color: var(--green); }
    .rung-empty { color: var(--muted); }

    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 20px 20px; }
    @media (max-width: 700px) { .bottom-grid { grid-template-columns: 1fr; } }
    .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 280px; overflow-y: auto; }
    .tbl { width: 100%; border-collapse: collapse; }
    .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
    .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
    .tbl tr:last-child td { border-bottom: none; }
    .log-wrap { background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; height: 280px; overflow-y: auto; font-size: 11px; line-height: 1.7; }
    .scan-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--cyan); margin-right: 6px; animation: blink 1.5s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }
    .empty { color: var(--muted); padding: 20px; text-align: center; font-size: 11px; }

    .c-cyan   { color: var(--cyan) !important; }
    .c-green  { color: var(--green) !important; }
    .c-red    { color: var(--red) !important; }
    .c-yellow { color: var(--yellow) !important; }
    .c-gold   { color: var(--gold) !important; }
    .c-purple { color: var(--purple) !important; }

    .market-card {
      background: var(--bg2); border: 1px solid var(--border); border-radius: 8px;
      padding: 8px 12px; margin-bottom: 6px;
    }
    .market-card-q { font-size: 11px; color: var(--text); margin-bottom: 6px; }
    .market-card-event { font-size: 9px; color: var(--muted); margin-bottom: 6px; }
    .side-btn {
      background: var(--bg3); border: 1px solid var(--border); color: var(--cyan);
      padding: 4px 10px; border-radius: 6px; font-size: 10px; font-family: inherit;
      cursor: pointer; margin-right: 6px; margin-bottom: 4px;
    }
    .side-btn:hover { background: var(--cyan); color: #001018; }
  </style>
</head>
<body>

<div class="header">
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <div class="logo">⚽ Draw<span>NO</span>Bot</div>
    <div class="match-tag" id="match-slug">loading…</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="color:var(--muted);font-size:10px"><span class="scan-dot"></span><span id="price-tag">NO price —</span></span>
    <span id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">${DRY_RUN ? '⚠️ DRY RUN' : '🔴 LIVE'}</span>
  </div>
</div>

<!-- Search -->
<div class="search-bar">
  <input id="match-url" type="text" placeholder="Paste Polymarket match URL (e.g. https://polymarket.com/sports/world-cup/fifwc-ger-par-2026-06-29)">
  <button id="search-btn">Load Match</button>
</div>
<div class="search-status" id="search-status"></div>

<div class="search-bar" style="margin-top:6px">
  <input id="market-q" type="text" placeholder="Or search ANY market — e.g. 'bitcoin up or down', 'fed rate', 'premier league'…">
  <button id="market-search-btn">Find Markets</button>
</div>
<div class="search-status" id="market-search-status"></div>
<div id="market-results" style="padding:0 20px 6px"></div>

<!-- Stats -->
<div class="stats-row">
  <div class="stat"><div class="stat-label">Total Capital</div><div class="stat-val c-cyan" id="total-mark">—</div><div class="stat-sub">mark-to-market</div></div>
  <div class="stat"><div class="stat-label">Session P&L</div><div class="stat-val" id="total-pnl">—</div><div class="stat-sub">vs $2000 start</div></div>
  <div class="stat"><div class="stat-label">Realized P&L</div><div class="stat-val" id="realized-pnl">—</div><div class="stat-sub">booked</div></div>
  <div class="stat"><div class="stat-label">Unrealized P&L</div><div class="stat-val" id="unrealized-pnl">—</div><div class="stat-sub">open positions</div></div>
  <div class="stat"><div class="stat-label">Cash (unallocated)</div><div class="stat-val c-gold" id="total-cash">—</div><div class="stat-sub" id="open-shares">— open shares</div></div>
  <div class="stat"><div class="stat-label">Match Ends In</div><div class="stat-val c-yellow" id="secs-to-end">—</div><div class="stat-sub">seconds</div></div>
  <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">—</div><div class="stat-sub">hh:mm:ss</div></div>
</div>

<!-- Match bar -->
<div class="match-bar">
  <div class="match-bar-item"><span class="match-bar-label">Event:</span><span class="match-bar-val" id="bar-title">—</span></div>
  <div class="match-bar-item"><span class="match-bar-label">Side:</span><span class="match-bar-val" id="bar-side">—</span></div>
  <div class="match-bar-item"><span class="match-bar-label">Price:</span><span class="match-bar-val" id="bar-price">—</span></div>
  <div class="match-bar-item"><span class="match-bar-label">Active Block:</span><span class="match-bar-val" id="bar-active-block">—</span></div>
  <div class="match-bar-item"><span class="match-bar-label">End Time:</span><span class="match-bar-val" id="bar-endtime">—</span></div>
  <div class="match-bar-item" id="endgame-flag" style="display:none"><span class="match-bar-val c-red">🚨 ENDGAME TRIGGERED</span></div>
</div>

<!-- Blocks -->
<div class="section">
  <div class="section-hdr">Price Blocks (10 x $200, real-time mark-to-market)</div>
  <div class="block-grid" id="block-grid"><div class="empty">🔭 Loading blocks…</div></div>
</div>

<!-- Trades + Logs -->
<div class="bottom-grid">
  <div>
    <div class="section-hdr" style="margin:0 0 8px">Trades</div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Time</th><th>Block</th><th>Side</th><th>Price</th><th>Shares</th><th>P&L</th></tr></thead>
        <tbody id="trade-body"><tr><td colspan="6" class="empty">No trades yet</td></tr></tbody>
      </table>
    </div>
  </div>
  <div>
    <div class="section-hdr" style="margin:0 0 8px">Bot Logs</div>
    <div class="log-wrap" id="logs"></div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  function fmt(s) {
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
    return [h,m,sec].map(v=>String(v).padStart(2,'0')).join(':');
  }
  function sgn(v) { return (v>=0?'+':'')+(v||0).toFixed(2); }
  function pClass(v) { return v>=0?'c-green':'c-red'; }

  document.getElementById('search-btn').addEventListener('click', async () => {
    const url = document.getElementById('match-url').value.trim();
    const statusEl = document.getElementById('search-status');
    if (!url) return;
    statusEl.textContent = 'Loading match…';
    statusEl.className = 'search-status';
    try {
      const res = await fetch('/api/search-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (data.ok) {
        statusEl.textContent = '✅ Loaded: ' + (data.title || data.slug);
        statusEl.className = 'search-status ok';
      } else {
        statusEl.textContent = '❌ ' + (data.error || 'Failed to load match');
        statusEl.className = 'search-status err';
      }
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.className = 'search-status err';
    }
  });

  async function runMarketSearch() {
    const q = document.getElementById('market-q').value.trim();
    const statusEl = document.getElementById('market-search-status');
    const resultsEl = document.getElementById('market-results');
    if (!q) return;
    statusEl.textContent = 'Searching…';
    statusEl.className = 'search-status';
    resultsEl.innerHTML = '';
    try {
      const res = await fetch('/api/search-markets?q=' + encodeURIComponent(q));
      const data = await res.json();
      if (!data.ok) {
        statusEl.textContent = '❌ ' + (data.error || 'Search failed');
        statusEl.className = 'search-status err';
        return;
      }
      if (!data.results || data.results.length === 0) {
        statusEl.textContent = 'No tradable markets found for "' + q + '"';
        statusEl.className = 'search-status';
        return;
      }
      statusEl.textContent = data.results.length + ' market(s) found — pick a side to start trading it:';
      statusEl.className = 'search-status ok';
      resultsEl.innerHTML = data.results.map((m, i) => {
        const sideBtns = m.outcomes.map(o =>
          '<button class="side-btn" data-i="' + i + '" data-side="' + o + '">Trade ' + o + '</button>'
        ).join('');
        return '<div class="market-card">' +
          '<div class="market-card-event">' + m.eventTitle + '</div>' +
          '<div class="market-card-q">' + m.question + '</div>' +
          sideBtns +
          '</div>';
      }).join('');

      resultsEl.querySelectorAll('.side-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const m = data.results[parseInt(btn.dataset.i, 10)];
          const side = btn.dataset.side;
          statusEl.textContent = 'Loading "' + m.question + '" — trading ' + side + '…';
          statusEl.className = 'search-status';
          try {
            const r = await fetch('/api/load-market', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ eventSlug: m.eventSlug, marketId: m.marketId, side })
            });
            const d = await r.json();
            if (d.ok) {
              statusEl.textContent = '✅ Now trading ' + side + ' on: ' + d.question;
              statusEl.className = 'search-status ok';
              resultsEl.innerHTML = '';
            } else {
              statusEl.textContent = '❌ ' + (d.error || 'Failed to load market');
              statusEl.className = 'search-status err';
            }
          } catch (e) {
            statusEl.textContent = '❌ ' + e.message;
            statusEl.className = 'search-status err';
          }
        });
      });
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.className = 'search-status err';
    }
  }
  document.getElementById('market-search-btn').addEventListener('click', runMarketSearch);
  document.getElementById('market-q').addEventListener('keydown', e => { if (e.key === 'Enter') runMarketSearch(); });

  socket.on('state', s => {
    document.getElementById('total-mark').textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl||0);
    pnlEl.className = 'stat-val '+pClass(s.totalPnl);
    const relEl = document.getElementById('realized-pnl');
    relEl.textContent = sgn(s.totalRealizedPnl||0);
    relEl.className = 'stat-val '+pClass(s.totalRealizedPnl);
    const unrelEl = document.getElementById('unrealized-pnl');
    unrelEl.textContent = sgn(s.totalUnrealizedPnl||0);
    unrelEl.className = 'stat-val '+pClass(s.totalUnrealizedPnl);
    document.getElementById('total-cash').textContent = '$'+(s.totalCash||0).toFixed(2);
    document.getElementById('open-shares').textContent = (s.totalOpenShares||0).toFixed(2)+' open shares';
    document.getElementById('secs-to-end').textContent = (s.secsToEnd!==null && s.secsToEnd!==undefined) ? s.secsToEnd+'s' : '—';
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    document.getElementById('price-tag').textContent = 'NO price '+(s.noPrice!==null ? s.noPrice.toFixed(3) : '—');
    document.getElementById('match-slug').textContent = s.eventTitle || s.eventSlug || '—';
    document.getElementById('bar-title').textContent = s.eventTitle || s.eventSlug || '—';
    document.getElementById('bar-side').textContent = s.tradeSide || '—';
    document.getElementById('bar-price').textContent = s.noPrice!==null ? s.noPrice.toFixed(3) : '—';
    document.getElementById('bar-endtime').textContent = s.matchEndTime ? s.matchEndTime.slice(0,19).replace('T',' ')+'Z' : 'unknown';
    document.getElementById('endgame-flag').style.display = s.endgameTriggered ? '' : 'none';

    const activeBlock = (s.blocks||[]).find(b => b.active);
    document.getElementById('bar-active-block').textContent = activeBlock ? activeBlock.range : '—';

    const grid = document.getElementById('block-grid');
    if (!s.blocks || s.blocks.length === 0) {
      grid.innerHTML = '<div class="empty">🔭 No blocks yet</div>';
    } else {
      grid.innerHTML = s.blocks.map(b => {
        const rungsHtml = b.rungs.map(r => {
          if (r.hasPosition) {
            return '<div class="rung-row rung-filled"><span>r'+r.offsetIdx+' filled @'+r.entryPrice.toFixed(2)+' ('+r.shares.toFixed(2)+'sh)</span><span>TP@'+r.tpPrice.toFixed(2)+' '+sgn(r.unrealizedPnl)+'</span></div>';
          } else if (r.restingPrice) {
            return '<div class="rung-row rung-resting"><span>r'+r.offsetIdx+' resting BUY @'+r.restingPrice.toFixed(2)+'</span><span>'+r.restingSize.toFixed(2)+'sh</span></div>';
          }
          return '<div class="rung-row rung-empty"><span>r'+r.offsetIdx+' idle</span><span>—</span></div>';
        }).join('');
        return \`<div class="block-card \${b.active ? 'is-active' : ''}">
          <div class="block-hdr">
            <div class="block-range">\${b.range}</div>
            <span class="\${b.active ? 'block-active-pill' : 'block-dormant-pill'}">\${b.active ? 'ACTIVE' : 'dormant'}</span>
          </div>
          <div class="block-body">
            <div class="block-row"><span class="block-key">Pivot</span><span>\${b.pivot.toFixed(2)}</span><span class="block-key">Cash</span><span>$\${b.cash.toFixed(2)}</span></div>
            <div class="block-row"><span class="block-key">Mark Value</span><span class="c-cyan">$\${b.markValue.toFixed(2)}</span></div>
            <div class="block-row"><span class="block-key">Realized</span><span class="\${b.realizedPnl>=0?'pnl-pos':'pnl-neg'}">\${sgn(b.realizedPnl)}</span><span class="block-key">Unrealized</span><span class="\${b.unrealized>=0?'pnl-pos':'pnl-neg'}">\${sgn(b.unrealized)}</span></div>
            <div class="rungs">\${rungsHtml}</div>
          </div>
        </div>\`;
      }).join('');
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '—';
        const pnlCls = (t.profit !== undefined) ? (t.profit>=0?'pnl-pos':'pnl-neg') : '';
        const sideColor = t.side === 'BUY' ? '#ffd740' : (t.side === 'SELL_ENDGAME' ? '#ff4757' : '#00e676');
        return '<tr>'+
          '<td>'+t.time+'</td>'+
          '<td>#'+t.block+'</td>'+
          '<td style="color:'+sideColor+'">'+t.side+'</td>'+
          '<td>'+(t.price||0).toFixed(3)+'</td>'+
          '<td>'+(t.shares||0).toFixed(2)+'</td>'+
          '<td class="'+pnlCls+'">'+pnlStr+'</td>'+
          '</tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="6" class="empty">No trades yet</td></tr>';
    }

    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌')||l.includes('🚨') ? '#ff4757'
                  : l.includes('💰')||l.includes('✅') ? '#00e676'
                  : l.includes('🪣')||l.includes('⬆️')||l.includes('🏁') ? '#ffd740'
                  : l.includes('🔭')||l.includes('🎯')||l.includes('⏰') ? '#00d4ff'
                  : l.includes('⚠️') ? '#ff9f0a'
                  : '#4a6080';
        return '<div style="color:'+col+'">'+l+'</div>';
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

console.log(`⚽ Draw-NO Block-Ladder Bot`);
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — demo $2000 capital, simulated fills, real API for data/orders');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
