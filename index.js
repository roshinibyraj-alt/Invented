'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const ladderBot   = require('./cricket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/api/hedge/status', (_, res) => {
  try { res.json(ladderBot.buildState()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (_, res) => {
  try { res.json(ladderBot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/resume', (_, res) => {
  try { res.json(ladderBot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/set-mode', (req, res) => {
  const { live } = req.body || {};
  if (typeof live !== 'boolean') return res.status(400).json({ ok: false, error: 'Missing boolean "live" field' });
  try { res.json(ladderBot.setMode(live)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🪙 BTC 5m Ladder Bot</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --purple: #7c3aed; --gold: #b8860b;
    --down: #7c6cf0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }
  .header { background: linear-gradient(135deg,#f0f4f8,#e4ecf5); border-bottom: 2px solid #0099cc44; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 20px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
  .logo span { color: var(--cyan); }
  .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
  .mode-dry { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
  .mode-live { background: #ff475722; color: var(--red); border: 1px solid var(--red); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .toolbar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: var(--cyan); color: #001018; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px; }
  .toolbar button.pause { background: var(--yellow); }
  .toolbar button.resume { background: var(--green); color: #fff; }
  .toolbar button.live-toggle { background: var(--red); color: #fff; }
  .toolbar button.live-toggle.is-live { background: var(--muted); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .toolbar-status { padding: 6px 20px 0; font-size: 10px; color: var(--muted); min-height: 14px; }
  .boundary-banner { margin: 10px 20px 0; padding: 10px 14px; background: #e6a80022; border: 1px solid var(--yellow); border-radius: 8px; font-size: 10.5px; color: #7a5c00; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; padding: 10px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 17px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .ladder-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 0 20px 16px; }
  @media (max-width: 760px) { .ladder-grid { grid-template-columns: 1fr; } }
  .side-card { background: var(--bg2); border: 2px solid var(--border); border-radius: 12px; overflow: hidden; }
  .side-card.up-card { border-color: #4fc3f766; }
  .side-card.down-card { border-color: #b39ddb66; }
  .side-hdr { background: #0d1d30; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; }
  .side-title { font-size: 13px; font-weight: bold; color: #ddd; }
  .side-sub { font-size: 9px; color: #8fb; }
  .side-badge { padding: 3px 10px; border-radius: 10px; font-size: 10px; font-weight: bold; }
  .side-up { background: #0099cc33; color: #4fc3f7; border: 1px solid #4fc3f7; }
  .side-down { background: #7c6cf033; color: #b39ddb; border: 1px solid #b39ddb; }
  .side-body { padding: 10px 14px; }
  .px { padding: 4px 6px; border-radius: 6px; background: var(--bg3); text-align: center; font-size: 9.5px; margin-bottom: 8px; }
  .rung-row { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; margin-bottom: 6px; font-size: 10px; display: flex; justify-content: space-between; align-items: center; gap: 6px; flex-wrap: wrap; }
  .rung-row.resting-entry { border-style: dashed; border-color: var(--yellow); background: #e6a80008; }
  .rung-row.position-open { border-color: var(--cyan); background: #0099cc08; }
  .rung-row.closed-row { opacity: .8; }
  .rung-id { color: var(--muted); font-size: 9px; min-width: 20px; }
  .rung-px { flex: 1; min-width: 90px; }
  .rung-sh { color: var(--muted); font-size: 9.5px; }
  .rung-status-badge { font-size: 8.5px; padding: 2px 7px; border-radius: 9px; white-space: nowrap; }
  .status-resting { background: #e6a80022; color: var(--yellow); border: 1px solid var(--yellow); }
  .status-open { background: #0099cc22; color: var(--cyan); border: 1px solid var(--cyan); }
  .status-idle { background: var(--bg3); color: var(--muted); border: 1px solid var(--border); }
  .status-risk { background: #e8304a22; color: var(--red); border: 1px solid var(--red); }
  .side-pnl { text-align: right; margin-top: 4px; font-size: 10.5px; }
  .divider { border-top: 1px dashed var(--border); margin: 8px 0; }
  .safeguard-note { margin: 0 20px 16px; font-size: 9.5px; color: var(--muted); }
  .bottom-grid { display: grid; grid-template-columns: 1fr; gap: 16px; padding: 0 20px 20px; }
  .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 320px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 10px; }
  .log-panel { background: #0d1420; color: #cfe8ff; border-radius: 10px; padding: 10px 12px; max-height: 220px; overflow-y: auto; font-size: 9.5px; margin: 0 20px 20px; }
  .log-panel div { padding: 1px 0; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">🪙 <span>BTC</span> 5m LADDER BOT</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">⏸️ Pause Trading</button>
    <button id="resume-btn" class="resume">▶️ Resume Trading</button>
    <button id="live-btn" class="live-toggle">🔴 Switch to LIVE</button>
  </div>
  <div class="toolbar-status" id="toolbar-status"></div>
  <div id="boundary-banner" style="display:none;" class="boundary-banner"></div>

  <div class="stats-row" id="stats-row"></div>

  <div class="section">
    <div class="section-hdr" id="strategy-hdr">Current Window — UP and DOWN each run an independent 4-rung ladder (no shared side, no switching)</div>
  </div>
  <div class="ladder-grid" id="ladder-grid"><div class="empty">Loading…</div></div>
  <div class="safeguard-note" id="safeguard-note"></div>

  <div class="bottom-grid">
    <div>
      <div class="section-hdr" style="padding:0 0 8px;">Window History (resolved)</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Window</th><th>Winner</th><th>Method</th><th>UP</th><th>UP PnL</th><th>DOWN</th><th>DOWN PnL</th><th>Combined</th></tr></thead>
          <tbody id="history-body"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr" style="padding:0 0 8px;">Recent Trades</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Window</th><th>Step</th><th>Side</th><th>Price</th><th>Shares</th><th>Cost/Rebate/PnL</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="section-hdr" style="margin:0 20px;">Live Log</div>
  <div class="log-panel" id="log-panel"><div class="empty">Loading…</div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  const $ = id => document.getElementById(id);

  $('pause-btn').onclick = () => fetch('/api/hedge/pause', { method: 'POST' }).then(() => flash('Trading paused'));
  $('resume-btn').onclick = () => fetch('/api/hedge/resume', { method: 'POST' }).then(() => flash('Trading resumed'));
  $('live-btn').onclick = () => {
    const wantLive = !$('live-btn').classList.contains('is-live');
    if (wantLive && !confirm('Switch to LIVE mode? This will place REAL resting GTC limit buy orders with REAL money on the BTC 5-minute Up/Down market ladders (4 rungs per side).')) return;
    fetch('/api/hedge/set-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ live: wantLive }) })
      .then(() => flash(wantLive ? 'Switched to LIVE' : 'Switched to DEMO'));
  };
  function flash(msg) { $('toolbar-status').textContent = msg; setTimeout(() => { $('toolbar-status').textContent = ''; }, 3000); }

  function fmtPx(n) { return n == null ? '—' : n.toFixed(3); }
  function fmt2(n) { return (n == null ? 0 : n).toFixed(2); }
  function fmt4(n) { return (n == null ? 0 : n).toFixed(4); }
  function pClass(n) { return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }
  function sgn(n) { return n == null ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }

  function renderStats(s) {
    const stats = [
      ['Equity (MTM)', '$' + fmt2(s.equity), ''],
      ['Bankroll (cash)', '$' + fmt2(s.bankroll), ''],
      ['Realized P&amp;L', sgn(s.realizedPnl), pClass(s.realizedPnl)],
      ['Unrealized P&amp;L', sgn(s.unrealizedPnl), pClass(s.unrealizedPnl)],
      ['Est. Maker Rebates', '+$' + fmt4(s.estimatedRebates), 'pnl-pos'],
      ['Wins / Losses', s.wins + ' / ' + s.losses, ''],
      ['Pending Resolution', s.pendingResolutionCount || 0, ''],
    ];
    $('stats-row').innerHTML = stats.map(([label, val, cls]) =>
      '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-val ' + cls + '">' + val + '</div></div>'
    ).join('');
  }

  function sideBadge(side) {
    return '<span class="side-badge ' + (side === 'up' ? 'side-up' : 'side-down') + '">' + side.toUpperCase() + '</span>';
  }

  // Mirrors the bot's own markPrice/leadingSide logic so the dashboard can
  // flag open rungs on the trailing side — since UP/DOWN prices move as
  // complements, a rung whose side isn't currently leading is unlikely to
  // see its own take-profit hit and will most likely ride to resolution
  // (paying $1/share if it still wins by close, $0 if not).
  function markPrice(leg, side) {
    const bid = side === 'up' ? leg.upBid : leg.downBid;
    const ask = side === 'up' ? leg.upAsk : leg.downAsk;
    return bid != null ? bid : (ask != null ? ask : null);
  }
  function leadingSide(leg) {
    if (!leg) return null;
    const u = markPrice(leg, 'up'), d = markPrice(leg, 'down');
    if (u == null && d == null) return null;
    if (u == null) return 'down';
    if (d == null) return 'up';
    return u >= d ? 'up' : 'down';
  }

  function rungRow(r, trailing) {
    let rowClass = 'status-idle', badge = 'Not placed', pnlSpan = '', riskBadge = '';
    if (r.closed) {
      rowClass = 'closed-row';
      badge = r.exitMethod === 'take-profit' ? 'TP filled' : 'Resolved';
      pnlSpan = '<span class="' + pClass(r.pnl) + '">' + sgn(r.pnl) + '</span>';
    } else if (r.entryFilled) {
      rowClass = 'position-open';
      if (r.noTakeProfit) {
        // Bot has confirmed and cancelled/skipped TP for this rung — the
        // opposite side's same rung already TP'd, so this one rides
        // straight to resolution.
        badge = 'Riding to resolution';
        riskBadge = '<span class="rung-status-badge status-risk">⏭ opposite rung TP\u2019d — TP skipped</span>';
      } else {
        badge = r.tpPending ? 'Open — TP resting' : 'Open';
        if (trailing) riskBadge = '<span class="rung-status-badge status-risk">⚠ trailing → likely resolution</span>';
      }
    } else if (r.entryPending) {
      rowClass = 'resting-entry';
      badge = 'Entry resting';
    }
    const statusClass = r.closed ? (r.pnl >= 0 ? 'status-open' : 'status-idle') : (r.entryFilled ? (r.noTakeProfit ? 'status-risk' : 'status-open') : (r.entryPending ? 'status-resting' : 'status-idle'));
    return '<div class="rung-row ' + rowClass + '">' +
      '<span class="rung-id">#' + r.id + '</span>' +
      '<span class="rung-px">' + r.entryPrice.toFixed(2) + ' → ' + r.tpPrice.toFixed(2) + '</span>' +
      '<span class="rung-sh">' + r.shares + 'sh</span>' +
      '<span class="rung-status-badge ' + statusClass + '">' + badge + '</span>' +
      riskBadge +
      pnlSpan +
    '</div>';
  }

  function sideCard(side, ss, leg) {
    if (!ss) return '';
    const ask = leg ? (side === 'up' ? leg.upAsk : leg.downAsk) : null;
    const bid = leg ? (side === 'up' ? leg.upBid : leg.downBid) : null;
    const leading = leadingSide(leg);
    // Only show the price-based "trailing" guess for rungs where the bot
    // hasn't already made an explicit noTakeProfit determination.
    const rows = ss.rungs.map(r => rungRow(r, !r.noTakeProfit && leading != null && leading !== side)).join('');
    return '<div class="side-card ' + side + '-card">' +
      '<div class="side-hdr"><div><div class="side-title">' + side.toUpperCase() + ' ladder' + (leading === side ? ' <span class="rung-status-badge status-open">leading</span>' : '') + '</div>' +
        '<div class="side-sub">' + ss.filledCount + '/' + ss.rungs.length + ' entries filled · ' + ss.closedCount + '/' + ss.rungs.length + ' closed</div></div>' + sideBadge(side) + '</div>' +
      '<div class="side-body">' +
        '<div class="px">ask ' + fmtPx(ask) + ' · bid ' + fmtPx(bid) + '</div>' +
        rows +
        '<div class="side-pnl ' + pClass(ss.realizedPnl) + '">Realized ' + sgn(ss.realizedPnl) + '</div>' +
      '</div>' +
    '</div>';
  }

  function renderCurrent(s) {
    const t = s.current.btc;
    if (!t) { $('ladder-grid').innerHTML = '<div class="empty">No active window yet</div>'; return; }
    $('ladder-grid').innerHTML =
      sideCard('up', t.sides.up, t.leg) +
      sideCard('down', t.sides.down, t.leg);
    const confBit = t.leg && t.leg.highConfSide ? ' · high-conf ' + t.leg.highConfSide.toUpperCase() + ' @' + fmtPx(t.leg.highConfPrice) : '';
    $('strategy-hdr').textContent = 'Window ' + (t.leg ? t.leg.slug.replace(/^btc-updown-5m-/, '') : '…') + ' — state: ' + t.state + confBit;
  }

  function renderTuningNote(s) {
    const rungsTxt = (s.rungs || []).map(r => '#' + r.id + ' ' + r.price.toFixed(2) + '→' + r.tp.toFixed(2) + ' (' + r.shares + 'sh)').join(', ');
    $('safeguard-note').textContent = 'Ladder rungs (both sides, independent): ' + rungsTxt + ' · GTC resting maker limits · unfilled entry cancelled at window close, unfilled TP rides to resolution';
  }

  function sideHistCell(side) {
    if (!side) return '—';
    return side.fills + ' fill' + (side.fills === 1 ? '' : 's') + ' (' + side.shares.toFixed(1) + 'sh)';
  }

  function renderHistory(list) {
    if (!list || !list.length) { $('history-body').innerHTML = '<tr><td colspan="8" class="empty">No resolved windows yet</td></tr>'; return; }
    $('history-body').innerHTML = list.map(h => {
      const upPnl = h.up ? (h.up.pnl + h.up.tpPnl) : null;
      const downPnl = h.down ? (h.down.pnl + h.down.tpPnl) : null;
      return '<tr><td>' + h.slug.replace(/^btc-updown-5m-/, '') + '</td>' +
      '<td>' + (h.winner || '?').toUpperCase() + '</td>' +
      '<td>' + (h.resolutionMethod || '—') + '</td>' +
      '<td>' + sideHistCell(h.up) + '</td>' +
      '<td class="' + pClass(upPnl) + '">' + sgn(upPnl) + '</td>' +
      '<td>' + sideHistCell(h.down) + '</td>' +
      '<td class="' + pClass(downPnl) + '">' + sgn(downPnl) + '</td>' +
      '<td class="' + pClass(h.combinedPnl) + '">' + sgn(h.combinedPnl) + '</td></tr>';
    }).join('');
  }

  function renderTrades(list) {
    if (!list || !list.length) { $('trade-body').innerHTML = '<tr><td colspan="7" class="empty">No trades yet</td></tr>'; return; }
    $('trade-body').innerHTML = list.map(t =>
      '<tr><td>' + t.time + '</td>' +
      '<td>' + (t.slug || '').replace(/^btc-updown-5m-/, '') + '</td>' +
      '<td>' + (t.step || '') + '</td>' +
      '<td>' + (t.side || '').toUpperCase() + '</td>' +
      '<td>' + (t.price != null ? t.price.toFixed(3) : '—') + '</td>' +
      '<td>' + (t.shares != null ? t.shares.toFixed(2) : '—') + '</td>' +
      '<td>' + (t.cost != null ? '$' + t.cost.toFixed(2) + (t.rebate ? ' +$' + t.rebate.toFixed(4) + ' rebate' : '') : (t.pnl != null ? sgn(t.pnl) : '—')) + '</td></tr>'
    ).join('');
  }

  function renderLogs(list) {
    if (!list || !list.length) { $('log-panel').innerHTML = '<div class="empty">No logs yet</div>'; return; }
    $('log-panel').innerHTML = list.map(l => '<div>' + l.replace(/</g, '&lt;') + '</div>').join('');
  }

  socket.on('hedgeState', (s) => {
    $('mode-badge').className = 'mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live');
    $('mode-badge').textContent = s.dryRun ? 'DEMO' : 'LIVE';
    $('live-btn').classList.toggle('is-live', !s.dryRun);
    $('live-btn').textContent = s.dryRun ? '🔴 Switch to LIVE' : '⚠️ Switch to DEMO';

    const banner = $('boundary-banner');
    if (s.waitingForBoundary) { banner.style.display = 'block'; banner.textContent = '⏳ Started mid-window — waiting for the next fresh 5-minute boundary before trading begins (no mid-window entries).'; }
    else banner.style.display = 'none';

    renderStats(s);
    renderCurrent(s);
    renderTuningNote(s);
    renderHistory(s.history);
    renderTrades(s.trades);
    renderLogs(s.logs);
  });

</script>
</body>
</html>`);
});

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log('🪙 BTC 5m Ladder Bot — independent UP/DOWN 4-rung ladders, resting GTC maker limit orders');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  ladderBot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
