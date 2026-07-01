'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./polymarket-scalp-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

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

app.post('/api/load-window', async (req, res) => {
  const { eventSlug, marketId, side } = req.body || {};
  if (!eventSlug || !side) return res.status(400).json({ ok: false, error: 'Missing eventSlug or side' });
  try {
    const result = await bot.loadWindow({ eventSlug, marketId, side });
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
  <title>🔥 Compounding Scalp Bot — BTC 5m</title>
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
    body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }

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

    .search-bar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; }
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

    /* ── HERO PRICE — big bold live price for the chosen side ── */
    .price-hero {
      margin: 16px 20px 0; border-radius: 14px; padding: 22px 24px;
      background: var(--bg2); border: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px;
    }
    .price-hero.state-long  { border-color: var(--green); box-shadow: 0 0 0 1px #00a85422; }
    .price-hero.state-flat  { border-color: var(--cyan);  box-shadow: 0 0 0 1px #00d4ff22; }
    .price-hero.state-frozen { border-color: var(--yellow); box-shadow: 0 0 0 1px #e6a80022; }
    .price-hero-left { display: flex; flex-direction: column; gap: 4px; }
    .price-hero-side {
      font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--muted);
    }
    .price-hero-side b { color: var(--text); }
    .price-hero-value {
      font-size: 64px; line-height: 1; font-weight: bold; color: var(--text);
      font-variant-numeric: tabular-nums; letter-spacing: -1px;
    }
    .price-hero-value.up   { color: var(--green); }
    .price-hero-value.down { color: var(--red); }
    @media (max-width: 600px) { .price-hero-value { font-size: 42px; } }
    .price-hero-right { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
    .price-hero-state-pill {
      font-size: 10px; padding: 4px 12px; border-radius: 20px; letter-spacing: 1px; text-transform: uppercase;
    }
    .pill-long   { background: #00a85422; color: var(--green); border: 1px solid var(--green); }
    .pill-flat   { background: #00d4ff15; color: var(--cyan);  border: 1px solid var(--cyan); }
    .pill-frozen { background: #e6a80022; color: var(--yellow); border: 1px solid var(--yellow); animation: pulse 2s infinite; }
    .price-hero-triggers { font-size: 10px; color: var(--muted); text-align: right; }
    .price-hero-triggers b { color: var(--text); }
    .price-hero-empty { color: var(--muted); font-size: 13px; }

    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 14px 20px; }
    .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
    .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
    .stat-val   { font-size: 20px; font-weight: bold; color: #1a2535; }
    .stat-sub   { font-size: 9px; color: var(--muted); margin-top: 3px; }

    .window-bar {
      background: var(--bg2); border: 1px solid var(--border);
      margin: 0 20px 14px; border-radius: 10px; padding: 10px 16px;
      display: flex; gap: 24px; flex-wrap: wrap; align-items: center;
    }
    .window-bar-item { font-size: 10px; }
    .window-bar-label { color: var(--muted); margin-right: 6px; }
    .window-bar-val { color: var(--cyan); font-weight: bold; }

    .section { padding: 0 20px 16px; }
    .section-hdr {
      font-size: 10px; color: var(--muted); text-transform: uppercase;
      letter-spacing: 2px; padding: 8px 0 8px;
      display: flex; align-items: center; gap: 8px;
    }
    .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }

    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 20px 20px; }
    @media (max-width: 700px) { .bottom-grid { grid-template-columns: 1fr; } }
    .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 320px; overflow-y: auto; }
    .tbl { width: 100%; border-collapse: collapse; }
    .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
    .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
    .tbl tr:last-child td { border-bottom: none; }
    .log-wrap { background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; height: 320px; overflow-y: auto; font-size: 11px; line-height: 1.7; }
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
    <div class="logo">🔥 Scalp<span>Bot</span></div>
    <div class="match-tag" id="window-slug">no window loaded</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="color:var(--muted);font-size:10px"><span class="scan-dot"></span><span id="uptime-tag">uptime —</span></span>
    <span id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">${DRY_RUN ? '⚠️ DRY RUN' : '🔴 LIVE'}</span>
  </div>
</div>

<!-- Search -->
<div class="search-bar">
  <input id="market-q" type="text" placeholder="Search a BTC 5m window — e.g. 'bitcoin up or down', or paste a Polymarket URL/slug…">
  <button id="market-search-btn">Find Windows</button>
</div>
<div class="search-status" id="market-search-status"></div>
<div id="market-results" style="padding:0 20px 6px"></div>

<!-- HERO: big bold live price for the chosen side -->
<div class="price-hero state-flat" id="price-hero">
  <div class="price-hero-left">
    <div class="price-hero-side">Side: <b id="hero-side">—</b></div>
    <div class="price-hero-value" id="hero-price">—</div>
  </div>
  <div class="price-hero-right">
    <span class="price-hero-state-pill pill-flat" id="hero-state-pill">no window</span>
    <div class="price-hero-triggers" id="hero-triggers">choose a side to start</div>
  </div>
</div>

<!-- Stats -->
<div class="stats-row">
  <div class="stat"><div class="stat-label">Stack Value</div><div class="stat-val c-cyan" id="stack-val">—</div><div class="stat-sub">mark-to-market</div></div>
  <div class="stat"><div class="stat-label">Total P&L</div><div class="stat-val" id="total-pnl">—</div><div class="stat-sub" id="capital-sub">vs start capital</div></div>
  <div class="stat"><div class="stat-label">Realized P&L</div><div class="stat-val" id="realized-pnl">—</div><div class="stat-sub">booked round trips</div></div>
  <div class="stat"><div class="stat-label">Unrealized P&L</div><div class="stat-val" id="unrealized-pnl">—</div><div class="stat-sub">open position</div></div>
  <div class="stat"><div class="stat-label">Round Trips</div><div class="stat-val c-gold" id="round-trips">—</div><div class="stat-sub">completed this window</div></div>
  <div class="stat"><div class="stat-label">Window Ends In</div><div class="stat-val c-yellow" id="secs-to-end">—</div><div class="stat-sub" id="freeze-sub">seconds</div></div>
  <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">—</div><div class="stat-sub">hh:mm:ss</div></div>
</div>

<!-- Window bar -->
<div class="window-bar">
  <div class="window-bar-item"><span class="window-bar-label">Event:</span><span class="window-bar-val" id="bar-title">—</span></div>
  <div class="window-bar-item"><span class="window-bar-label">Side:</span><span class="window-bar-val" id="bar-side">—</span></div>
  <div class="window-bar-item"><span class="window-bar-label">State:</span><span class="window-bar-val" id="bar-state">—</span></div>
  <div class="window-bar-item"><span class="window-bar-label">Last Buy:</span><span class="window-bar-val" id="bar-lastbuy">—</span></div>
  <div class="window-bar-item"><span class="window-bar-label">Last Sell:</span><span class="window-bar-val" id="bar-lastsell">—</span></div>
  <div class="window-bar-item"><span class="window-bar-label">Resolves:</span><span class="window-bar-val" id="bar-endtime">—</span></div>
  <div class="window-bar-item" id="freeze-flag" style="display:none"><span class="window-bar-val c-yellow">🧊 FROZEN — riding to settlement</span></div>
</div>

<!-- Trades + Logs -->
<div class="bottom-grid">
  <div>
    <div class="section-hdr" style="margin:0 0 8px">Trades</div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Time</th><th>Side</th><th>Price</th><th>Shares</th><th>Reason</th><th>P&L</th></tr></thead>
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

  let lastPrice = null;

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
        statusEl.textContent = 'No tradable windows found for "' + q + '"';
        statusEl.className = 'search-status';
        return;
      }
      statusEl.textContent = data.results.length + ' window(s) found — pick a side to start trading it:';
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
            const r = await fetch('/api/load-window', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ eventSlug: m.eventSlug, marketId: m.marketId, side })
            });
            const d = await r.json();
            if (d.ok) {
              statusEl.textContent = '✅ Now trading ' + side + ' on: ' + d.question;
              statusEl.className = 'search-status ok';
              resultsEl.innerHTML = '';
              document.getElementById('hero-side').textContent = side;
            } else {
              statusEl.textContent = '❌ ' + (d.error || 'Failed to load window');
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
    // ── Hero price ──
    const hero = document.getElementById('price-hero');
    const priceEl = document.getElementById('hero-price');
    const pillEl = document.getElementById('hero-state-pill');
    const trigEl = document.getElementById('hero-triggers');

    document.getElementById('hero-side').textContent = s.tradeSide || '—';

    if (s.price !== null && s.price !== undefined) {
      const dir = lastPrice !== null ? (s.price > lastPrice ? 'up' : (s.price < lastPrice ? 'down' : '')) : '';
      priceEl.textContent = s.price.toFixed(3);
      priceEl.className = 'price-hero-value ' + dir;
      lastPrice = s.price;
    } else {
      priceEl.textContent = '—';
      priceEl.className = 'price-hero-value';
    }

    hero.classList.remove('state-long', 'state-flat', 'state-frozen');
    pillEl.classList.remove('pill-long', 'pill-flat', 'pill-frozen');
    if (s.frozen) {
      hero.classList.add('state-frozen');
      pillEl.classList.add('pill-frozen');
      pillEl.textContent = 'FROZEN — riding to settlement';
    } else if (s.state === 'LONG') {
      hero.classList.add('state-long');
      pillEl.classList.add('pill-long');
      pillEl.textContent = 'LONG ' + (s.shares || 0).toFixed(2) + ' sh';
    } else {
      hero.classList.add('state-flat');
      pillEl.classList.add('pill-flat');
      pillEl.textContent = s.tradeSide ? 'FLAT — waiting to enter' : 'no window';
    }

    if (s.state === 'LONG' && s.lastBuyPrice !== null) {
      trigEl.innerHTML = 'sell trigger &ge; <b>' + (s.lastBuyPrice + 0.10).toFixed(2) + '</b>';
    } else if (s.state === 'FLAT' && s.lastSellPrice !== null) {
      trigEl.innerHTML = 'rebuy trigger &le; <b>' + (s.lastSellPrice - 0.05).toFixed(2) + '</b>';
    } else if (s.tradeSide) {
      trigEl.textContent = 'initial entry pending';
    } else {
      trigEl.textContent = 'choose a side to start';
    }

    // ── Stats ──
    document.getElementById('stack-val').textContent = '$' + (s.markValue || 0).toFixed(2);
    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl || 0);
    pnlEl.className = 'stat-val ' + pClass(s.totalPnl);
    const relEl = document.getElementById('realized-pnl');
    relEl.textContent = sgn(s.realizedPnl || 0);
    relEl.className = 'stat-val ' + pClass(s.realizedPnl);
    const unrelEl = document.getElementById('unrealized-pnl');
    unrelEl.textContent = sgn(s.unrealizedPnl || 0);
    unrelEl.className = 'stat-val ' + pClass(s.unrealizedPnl);
    document.getElementById('round-trips').textContent = s.roundTrips || 0;
    document.getElementById('secs-to-end').textContent = (s.secsToEnd !== null && s.secsToEnd !== undefined) ? s.secsToEnd + 's' : '—';
    document.getElementById('freeze-sub').textContent = s.frozen ? 'frozen — holding to settlement' : 'until freeze/resolution';
    document.getElementById('uptime').textContent = fmt(s.uptime || 0);
    document.getElementById('uptime-tag').textContent = 'uptime ' + fmt(s.uptime || 0);

    // ── Window bar ──
    document.getElementById('window-slug').textContent = s.eventTitle || 'no window loaded';
    document.getElementById('bar-title').textContent = s.eventTitle || '—';
    document.getElementById('bar-side').textContent = s.tradeSide || '—';
    document.getElementById('bar-state').textContent = s.frozen ? 'FROZEN' : (s.state || '—');
    document.getElementById('bar-lastbuy').textContent = s.lastBuyPrice !== null && s.lastBuyPrice !== undefined ? s.lastBuyPrice.toFixed(3) : '—';
    document.getElementById('bar-lastsell').textContent = s.lastSellPrice !== null && s.lastSellPrice !== undefined ? s.lastSellPrice.toFixed(3) : '—';
    document.getElementById('bar-endtime').textContent = s.windowEndTime ? s.windowEndTime.slice(0,19).replace('T',' ')+'Z' : 'unknown';
    document.getElementById('freeze-flag').style.display = s.frozen ? '' : 'none';

    // ── Trades ──
    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        const pnlStr = (t.profit !== undefined) ? sgn(t.profit) : '—';
        const pnlCls = (t.profit !== undefined) ? (t.profit >= 0 ? 'pnl-pos c-green' : 'pnl-neg c-red') : '';
        const sideColor = t.side === 'BUY' ? '#00a854' : '#e8304a';
        return '<tr>' +
          '<td>' + t.time + '</td>' +
          '<td style="color:' + sideColor + '">' + t.side + '</td>' +
          '<td>' + (t.price || 0).toFixed(3) + '</td>' +
          '<td>' + (t.shares || 0).toFixed(2) + '</td>' +
          '<td style="color:var(--muted)">' + (t.reason || '') + '</td>' +
          '<td class="' + pnlCls + '">' + pnlStr + '</td>' +
          '</tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="6" class="empty">No trades yet</td></tr>';
    }

    // ── Logs ──
    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌') ? '#e8304a'
                  : l.includes('🔴') ? '#e8304a'
                  : l.includes('🟢') || l.includes('✅') ? '#00a854'
                  : l.includes('🧊') ? '#e6a800'
                  : l.includes('🚀') || l.includes('⏰') ? '#0099cc'
                  : l.includes('⚠️') ? '#d97706'
                  : '#7a8fa8';
        return '<div style="color:' + col + '">' + l + '</div>';
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

console.log(`🔥 Compounding Scalp Bot — BTC 5m window`);
console.log(`🚦 DRY_RUN=${DRY_RUN}`);
if (DRY_RUN) console.log('⚠️  DRY RUN — demo capital, simulated fills, real API for data/orders');
else         console.log('🔴 LIVE MODE — real money');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
  });
});
