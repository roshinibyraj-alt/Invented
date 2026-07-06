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

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚡ BTC Ladder Scalper</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --purple: #7c3aed; --gold: #b8860b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }
  .header { background: linear-gradient(135deg,#f0f4f8,#e4ecf5); border-bottom: 2px solid #0099cc44; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 22px; font-weight: bold; color: var(--gold); letter-spacing: 1px; }
  .logo span { color: var(--cyan); }
  .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
  .mode-dry { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
  .mode-live { background: #ff475722; color: var(--red); border: 1px solid var(--red); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .toolbar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: var(--cyan); color: #001018; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px; }
  .toolbar button.pause { background: var(--yellow); }
  .toolbar button.resume { background: var(--green); color: #fff; }
  .toolbar button:hover { opacity: .85; }
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 14px 20px; }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .stat-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .stat-val { font-size: 20px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .section { padding: 0 20px 16px; }
  .section-hdr { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; padding: 8px 0; display: flex; align-items: center; gap: 8px; }
  .section-hdr::after { content:''; flex:1; height:1px; background: var(--border); }
  .pair-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 10px; }
  .edge-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; overflow-x: auto; }
  .edge-table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; }
  .edge-table th { text-align: right; color: var(--muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .edge-table th:first-child, .edge-table td:first-child { text-align: left; }
  .edge-table td { text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .edge-table tbody tr:last-child td { border-bottom: none; }
  .edge-note { font-size: 11px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
  .pair-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .pair-hdr { background: #0d1d30; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
  .pair-sym { font-size: 13px; font-weight: bold; color: #ddd; }
  .pair-timer { font-size: 10px; color: var(--cyan); }
  .pair-phase { font-size: 9px; padding: 2px 8px; border-radius: 10px; background: #0099cc33; color: var(--cyan); }
  .pair-body { padding: 8px 12px; }
  .pair-row { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; }
  .pair-key { color: var(--muted); }
  .side-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
  .side-box { border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; }
  .side-box .side-title { font-size: 10px; font-weight: bold; margin-bottom: 4px; }
  .side-box.up .side-title { color: var(--green); }
  .side-box.down .side-title { color: var(--red); }
  .side-box .side-row { font-size: 9px; color: var(--muted); display: flex; justify-content: space-between; margin-bottom: 2px; }
  .side-box .side-row span:last-child { color: var(--text); text-align: right; }
  .side-box .side-timer { font-size: 9px; color: var(--purple); text-align: right; margin-top: 2px; }
  .buy-list { margin-top: 4px; max-height: 90px; overflow-y: auto; border-top: 1px dashed var(--border); padding-top: 3px; }
  .buy-list .buy-row { font-size: 8.5px; color: var(--muted); display: flex; justify-content: space-between; padding: 1px 0; }
  .buy-list .buy-row span:last-child { color: var(--text); }
  .config-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin: 0 20px 14px; }
  .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-top: 6px; }
  .cfg-item { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
  .cfg-item .cfg-label { font-size: 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
  .cfg-item .cfg-val { font-size: 12px; color: var(--gold); }
  .badge-count { display: inline-block; background: var(--purple); color: #fff; border-radius: 8px; padding: 0 6px; font-size: 9px; margin-left: 4px; }
  .exposure-bar-wrap { margin-top: 4px; height: 6px; background: var(--bg3); border-radius: 4px; overflow: hidden; }
  .exposure-bar { height: 100%; border-radius: 4px; transition: width .3s; }
  .exposure-ok { background: var(--green); }
  .exposure-warn { background: var(--yellow); }
  .exposure-full { background: var(--red); }
  .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 20px 20px; }
  .tbl-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; max-height: 320px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 6px 8px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); font-size: 10px; }
  .logs-wrap { background: #0d1420; border: 1px solid var(--border); border-radius: 10px; padding: 10px; max-height: 320px; overflow-y: auto; font-size: 10px; }
  .logs-wrap div { padding: 1px 0; }
  .empty { padding: 20px; text-align: center; color: var(--muted); font-size: 10px; }
  .equity-wrap { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin: 0 20px 14px; }
  .equity-hdr { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .equity-hdr .title { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .equity-hdr .val { font-size: 13px; }
  .equity-svg { width: 100%; height: 90px; display: block; }
  .session-banner { margin: 14px 20px 0; border-radius: 12px; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; border: 1px solid var(--border); }
  .session-banner.weekend { background: linear-gradient(135deg,#e6f7ff,#d9f1ff); border-color: #0099cc55; }
  .session-banner.weekday { background: linear-gradient(135deg,#f3ecff,#ece0ff); border-color: #7c3aed55; }
  .session-left { display: flex; align-items: center; gap: 12px; }
  .session-icon { font-size: 26px; line-height: 1; }
  .session-title { font-size: 14px; font-weight: bold; letter-spacing: .5px; }
  .session-title.weekend { color: var(--cyan); }
  .session-title.weekday { color: var(--purple); }
  .session-sub { font-size: 10px; color: var(--muted); margin-top: 3px; font-weight: normal; }
  .session-right { text-align: right; }
  .session-countdown-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; }
  .session-countdown { font-size: 20px; font-weight: bold; font-variant-numeric: tabular-nums; }
  .session-countdown.weekend { color: var(--cyan); }
  .session-countdown.weekday { color: var(--purple); }
  .pair-mode-chip { font-size: 8px; padding: 2px 7px; border-radius: 10px; font-weight: bold; letter-spacing: .5px; }
  .pair-mode-chip.weekend { background: #0099cc33; color: var(--cyan); }
  .pair-mode-chip.weekday { background: #7c3aed33; color: var(--purple); }
  .side-box.inactive { opacity: .5; display: flex; align-items: center; justify-content: center; text-align: center; min-height: 78px; }
  .side-box.inactive .side-inactive-msg { font-size: 10px; color: var(--muted); line-height: 1.7; letter-spacing: .3px; }
  .side-box.inactive .side-inactive-msg .small { font-size: 8.5px; display: block; }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">⚡ <span>BTC LADDER</span> SCALPER</div>
    <div id="mode-badge" class="mode-badge ${DRY_RUN ? 'mode-dry' : 'mode-live'}">${DRY_RUN ? 'DRY RUN' : '🔴 LIVE'}</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">Pause</button>
    <button id="resume-btn" class="resume">Resume</button>
  </div>

  <div class="session-banner weekend" id="session-banner">
    <div class="session-left">
      <div class="session-icon" id="session-icon">📅</div>
      <div>
        <div class="session-title weekend" id="session-title">Loading schedule…</div>
        <div class="session-sub" id="session-sub">&nbsp;</div>
      </div>
    </div>
    <div class="session-right">
      <div class="session-countdown-label" id="session-countdown-label">—</div>
      <div class="session-countdown weekend" id="session-countdown">—:—:—</div>
    </div>
  </div>

  <div class="section-hdr" style="padding:14px 20px 0;">Capital &amp; P&amp;L</div>
  <div class="stats-row">
    <div class="stat"><div class="stat-label">Demo Capital (Start)</div><div class="stat-val" id="total-capital">$0.00</div></div>
    <div class="stat"><div class="stat-label">Current Equity</div><div class="stat-val" id="total-mark">$0.00</div></div>
    <div class="stat"><div class="stat-label">Total Net P&amp;L</div><div class="stat-val" id="total-pnl">$0.00</div></div>
    <div class="stat"><div class="stat-label">Return %</div><div class="stat-val" id="total-pnl-pct">0.00%</div></div>
    <div class="stat"><div class="stat-label">Realized P&amp;L</div><div class="stat-val" id="total-realized">$0.00</div></div>
    <div class="stat"><div class="stat-label">Unrealized P&amp;L</div><div class="stat-val" id="total-unrealized">$0.00</div></div>
    <div class="stat"><div class="stat-label">Cash Bankroll</div><div class="stat-val" id="total-bankroll">$0.00</div></div>
    <div class="stat"><div class="stat-label">Reserved in Orders</div><div class="stat-val" id="total-reserved">$0.00</div></div>
  </div>
  <div class="stats-row">
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-val" id="total-winrate">—</div></div>
    <div class="stat"><div class="stat-label">Wins / Losses</div><div class="stat-val" id="total-wl">0 / 0</div></div>
    <div class="stat"><div class="stat-label">Closed Trades</div><div class="stat-val" id="total-trades">0</div></div>
    <div class="stat"><div class="stat-label">Rebates Earned</div><div class="stat-val pnl-pos" id="total-rebates">$0.00</div></div>
    <div class="stat"><div class="stat-label">Fees Paid</div><div class="stat-val" id="total-fees">$0.00</div></div>
    <div class="stat"><div class="stat-label">System State</div><div class="stat-val" id="trading-flag">—</div></div>
    <div class="stat"><div class="stat-label">Uptime</div><div class="stat-val" id="uptime">0s</div></div>
    <div class="stat"><div class="stat-label">Mode</div><div class="stat-val" id="mode-stat">—</div></div>
  </div>

  <div class="equity-wrap">
    <div class="equity-hdr">
      <div class="title">Performance Curve</div>
      <div class="val" id="equity-val">$0.00</div>
    </div>
    <svg id="equity-chart" class="equity-svg" viewBox="0 0 600 90" preserveAspectRatio="none"></svg>
  </div>

  <div class="config-wrap">
    <div class="equity-hdr"><div class="title">Live Strategy Config</div></div>
    <div class="config-grid" id="config-grid"></div>
  </div>

  <div class="section">
    <div class="section-hdr">Edge by Ladder Price (lifetime, both sides combined)</div>
    <div class="edge-wrap">
      <table class="edge-table">
        <thead>
          <tr>
            <th>Price</th><th>Fills</th><th>Open</th><th>TP Wins</th><th>Res. Wins</th><th>Res. Losses</th>
            <th>Win Rate</th><th>Avg P&amp;L/Fill</th><th>Total P&amp;L</th><th>ROI %</th>
          </tr>
        </thead>
        <tbody id="edge-tbody"></tbody>
      </table>
      <div class="edge-note">Win Rate = (TP bounces + outright resolution wins) ÷ fills with a known outcome. ROI % = total P&amp;L ÷ total $ risked at that price. A real edge shows up as consistently positive ROI at a given price across a large sample — a handful of fills proves nothing either way.</div>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr">Active Metric Matrix</div>
    <div class="pair-grid" id="pair-grid"><div class="empty">Loading Live Asset Configurations...</div></div>
  </div>


  <div class="bottom-grid">
    <div>
      <div class="section-hdr">Trade Logs</div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>Time</th><th>Asset</th><th>Side</th><th>Reason</th><th>Price</th><th>Shares</th></tr></thead>
          <tbody id="trade-body"><tr><td colspan="6" class="empty">No executions recorded yet</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="section-hdr">Console Output</div>
      <div class="logs-wrap" id="logs"></div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  function sgn(n) { n = n || 0; return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2); }
  function pClass(n) { return (n || 0) >= 0 ? 'pnl-pos' : 'pnl-neg'; }
  function fmt(s) { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60; return (h?h+'h ':'')+(m?m+'m ':'')+ss+'s'; }
  function fmtSecs(s) { if (s === null || s === undefined) return '—'; const m = Math.floor(s/60), ss = s%60; return m+'m '+String(ss).padStart(2,'0')+'s'; }

  function buildEquitySvg(points, width, height, startVal) {
    if (!points || points.length < 2) {
      return '<line x1="0" y1="'+(height/2)+'" x2="'+width+'" y2="'+(height/2)+'" stroke="#3a4a60" stroke-width="1" stroke-dasharray="3,3"/>';
    }
    const vals = points.map(p => p.equity);
    let min = Math.min(...vals, startVal != null ? startVal : vals[0]);
    let max = Math.max(...vals, startVal != null ? startVal : vals[0]);
    if (max - min < 0.01) { max += 1; min -= 1; }
    const n = points.length;
    const coords = points.map((p, i) => {
      const x = (i / (n - 1)) * width;
      const y = height - ((p.equity - min) / (max - min)) * height;
      return [x, y];
    });
    const up = vals[vals.length - 1] >= vals[0];
    const color = up ? '#00c853' : '#ff4757';
    const linePath = 'M' + coords.map(c => c[0].toFixed(1)+','+c[1].toFixed(1)).join(' L');
    const fillPath = linePath + ' L' + width + ',' + height + ' L0,' + height + ' Z';
    return '<path d="'+fillPath+'" fill="'+color+'22" stroke="none"/>' + '<path d="'+linePath+'" fill="none" stroke="'+color+'" stroke-width="1.6"/>';
  }

  function rungBadge(status) {
    switch (status) {
      case 'pending':   return { text: 'WAIT',  cls: '' };
      case 'resting':   return { text: 'OPEN',  cls: 'pnl-pos' };
      case 'filled':    return { text: 'HELD→TP', cls: '' };
      case 'done':      return { text: 'TP ✓',  cls: 'pnl-pos' };
      case 'cancelled': return { text: 'PAUSED', cls: 'pnl-neg' };
      case 'resolved':  return { text: 'SETTLED', cls: '' };
      default:          return { text: status || '—', cls: '' };
    }
  }

  function sideBox(label, cls, s, isActive) {
    if (!s) s = {};
    if (isActive === false) {
      return '<div class="side-box '+cls+' inactive">'+
        '<div class="side-inactive-msg">'+label+' — FILTERED OUT<span class="small">Inactive this window</span></div>'+
      '</div>';
    }
    const ladder = s.ladder || [];
    const ladderHtml = ladder.length
      ? '<div class="buy-list">'+ladder.map(r => {
          const b = rungBadge(r.status);
          const detail = r.status === 'filled' || r.status === 'done'
            ? r.shares+'sh → tp '+(r.tpPrice!=null?r.tpPrice.toFixed(2):'—')
            : (r.status === 'resting' ? r.shares+'sh resting' : '');
          return '<div class="buy-row"><span>'+r.price.toFixed(2)+'</span><span class="'+b.cls+'">'+b.text+(detail?' — '+detail:'')+'</span></div>';
        }).join('')+'</div>'
      : '';
    return '<div class="side-box '+cls+'">'+
      '<div class="side-title">'+label+'</div>'+
      '<div class="side-row"><span>Ladder</span><span>'+(s.pendingCount||0)+' wait / '+(s.restingCount||0)+' open / '+(s.openCount||0)+' held / '+(s.doneCount||0)+' tp✓ / '+(s.cancelledCount||0)+' paused</span></div>'+
      ladderHtml+
      '<div class="side-row"><span>Held (awaiting TP)</span><span>'+(s.heldShares||0).toFixed(0)+'sh ($'+(s.heldCost||0).toFixed(2)+')</span></div>'+
      '<div class="side-row"><span>Resting Buy Cost</span><span>$'+(s.restingCost||0).toFixed(2)+'</span></div>'+
    '</div>';
  }

  document.getElementById('pause-btn').addEventListener('click', async () => { await fetch('/api/pause', { method: 'POST' }); });
  document.getElementById('resume-btn').addEventListener('click', async () => { await fetch('/api/resume', { method: 'POST' }); });

  function pctStr(n) { n = n || 0; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function round2ish(n) { return Math.round((n||0) * 100) / 100; }

  // ── Session banner (weekend vs weekday-filter) ──
  let schedule = null;      // { mode, nextBoundaryMs } — refreshed from each 'state' event, ticked locally every second
  let configCache = {};     // last-seen s.config, so renderSession() can show the right TP prices between socket events
  function fmtCountdown(ms) {
    if (ms == null || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    if (d > 0) return d+'d '+String(h).padStart(2,'0')+'h '+String(m).padStart(2,'0')+'m';
    return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
  }
  function renderSession() {
    if (!schedule) return;
    const isWeekend = schedule.mode === 'weekend';
    const banner = document.getElementById('session-banner');
    const title = document.getElementById('session-title');
    const countdown = document.getElementById('session-countdown');
    banner.className = 'session-banner ' + (isWeekend ? 'weekend' : 'weekday');
    title.className = 'session-title ' + (isWeekend ? 'weekend' : 'weekday');
    countdown.className = 'session-countdown ' + (isWeekend ? 'weekend' : 'weekday');
    document.getElementById('session-icon').textContent = isWeekend ? '📅' : '🎯';
    title.textContent = isWeekend ? 'WEEKEND — FULL LADDER' : 'WEEKDAY — DIRECTIONAL FILTER';
    document.getElementById('session-sub').textContent = isWeekend
      ? 'Both sides trade normally, TP $'+(configCache.tpPrice!=null?configCache.tpPrice.toFixed(2):'0.70')
      : "Only the previous window's winning side trades next window, TP $"+(configCache.weekdayFilterTpPrice!=null?configCache.weekdayFilterTpPrice.toFixed(2):'0.99');
    document.getElementById('session-countdown-label').textContent = isWeekend ? 'Weekday filter resumes in' : 'Weekend mode resumes in';
    countdown.textContent = fmtCountdown(schedule.nextBoundaryMs - Date.now());
  }
  setInterval(renderSession, 1000);

  socket.on('state', s => {
    const totalCapital = s.totalCapital || 0;
    const totalReserved = (s.pairStates || []).reduce((sum, p) => {
      const up = p.sides?.Up?.restingCost || 0;
      const down = p.sides?.Down?.restingCost || 0;
      return sum + up + down;
    }, 0);
    const pnlPct = totalCapital > 0 ? (s.totalPnl / totalCapital) * 100 : 0;

    schedule = s.schedule || schedule;
    configCache = s.config || configCache;
    renderSession();

    document.getElementById('total-capital').textContent = '$'+totalCapital.toFixed(2);
    document.getElementById('total-mark').textContent = '$'+(s.totalMarkValue||0).toFixed(2);
    const pnlEl = document.getElementById('total-pnl');
    pnlEl.textContent = sgn(s.totalPnl); pnlEl.className = 'stat-val ' + pClass(s.totalPnl);
    const pnlPctEl = document.getElementById('total-pnl-pct');
    pnlPctEl.textContent = pctStr(pnlPct); pnlPctEl.className = 'stat-val ' + pClass(pnlPct);
    const realEl = document.getElementById('total-realized');
    realEl.textContent = sgn(s.totalRealizedPnl); realEl.className = 'stat-val ' + pClass(s.totalRealizedPnl);
    const unrealEl = document.getElementById('total-unrealized');
    unrealEl.textContent = sgn(s.totalUnrealizedPnl); unrealEl.className = 'stat-val ' + pClass(s.totalUnrealizedPnl);
    document.getElementById('total-bankroll').textContent = '$'+(s.totalBankroll||0).toFixed(2);
    document.getElementById('total-reserved').textContent = '$'+totalReserved.toFixed(2);

    document.getElementById('total-winrate').textContent = s.winRate!=null ? s.winRate.toFixed(1)+'%' : '—';
    document.getElementById('total-wl').textContent = (s.totalWins||0)+' / '+(s.totalLosses||0);
    document.getElementById('total-trades').textContent = (s.totalWins||0)+(s.totalLosses||0);
    document.getElementById('total-rebates').textContent = '$'+(s.totalRebatesEarned||0).toFixed(4);
    document.getElementById('total-fees').textContent = '$'+(s.totalFeesPaid||0).toFixed(4);
    document.getElementById('uptime').textContent = fmt(s.uptime||0);
    document.getElementById('mode-stat').textContent = s.dryRun ? 'DRY RUN' : 'LIVE';
    const tf = document.getElementById('trading-flag');
    tf.textContent = s.tradingEnabled ? 'ACTIVE' : 'PAUSED';
    tf.className = 'stat-val ' + (s.tradingEnabled ? 'pnl-pos' : 'pnl-neg');

    const eqVal = document.getElementById('equity-val');
    eqVal.textContent = '$'+(s.totalMarkValue||0).toFixed(2)+' ('+pctStr(pnlPct)+')';
    eqVal.className = 'val ' + pClass(s.totalPnl);
    document.getElementById('equity-chart').innerHTML = buildEquitySvg(s.totalEquityCurve, 600, 90, s.totalCapital);

    const cfg = s.config || {};
    const cfgGrid = document.getElementById('config-grid');
    if (cfgGrid) {
      const items = [
        ['Ladder Range', (cfg.ladderMin!=null?cfg.ladderMin.toFixed(2):'—')+'–'+(cfg.ladderMax!=null?cfg.ladderMax.toFixed(2):'—')],
        ['Ladder Step', cfg.ladderStep??'—'],
        ['Rungs', (cfg.ladderPrices?cfg.ladderPrices.length:'—')],
        ['TP (weekend)', cfg.tpPrice??'—'],
        ['TP (weekday filter)', cfg.weekdayFilterTpPrice??'—'],
        ['Shares / Rung', (cfg.fixedShares??'—')+'sh'],
        ['Entry Cutoff', (cfg.entryCutoffSecs??'—')+'s'],
        ['Taker Fee Rate', ((cfg.cryptoTakerFeeRate||0)*100).toFixed(0)+'%'],
        ['Maker Rebate Share', ((cfg.cryptoMakerRebateShare||0)*100).toFixed(0)+'%'],
      ];
      cfgGrid.innerHTML = items.map(([label,val]) => '<div class="cfg-item"><div class="cfg-label">'+label+'</div><div class="cfg-val">'+val+'</div></div>').join('');
    }

    const edgeBody = document.getElementById('edge-tbody');
    if (s.rungStats && s.rungStats.length) {
      edgeBody.innerHTML = s.rungStats.map(r => {
        const fills = r.fills || 0;
        const wrCls = r.winRate == null ? '' : (r.winRate >= 50 ? 'pnl-pos' : 'pnl-neg');
        const pnlCls = pClass(r.totalPnl);
        const roiCls = pClass(r.roiPct);
        return '<tr>'+
          '<td>'+r.price.toFixed(2)+'</td>'+
          '<td>'+fills+'</td>'+
          '<td>'+(r.openCount||0)+'</td>'+
          '<td>'+(r.tpWins||0)+'</td>'+
          '<td>'+(r.resolvedWins||0)+'</td>'+
          '<td>'+(r.resolvedLosses||0)+'</td>'+
          '<td class="'+wrCls+'">'+(r.winRate!=null?r.winRate.toFixed(1)+'%':'—')+'</td>'+
          '<td class="'+pnlCls+'">'+(r.avgPnlPerFill!=null?sgn(r.avgPnlPerFill):'—')+'</td>'+
          '<td class="'+pnlCls+'">'+sgn(r.totalPnl||0)+'</td>'+
          '<td class="'+roiCls+'">'+(r.roiPct!=null?pctStr(r.roiPct):'—')+'</td>'+
        '</tr>';
      }).join('');
    } else {
      edgeBody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);">No fills yet</td></tr>';
    }

    const grid = document.getElementById('pair-grid');
    if (!s.pairStates || s.pairStates.length === 0) {
      grid.innerHTML = '<div class="empty">No Asset Data</div>';
    } else {
      grid.innerHTML = s.pairStates.map(p => {
        const startCap = s.perPairCapital || 0;
        const pPnl = round2ish((p.markValue||0) - startCap);
        const pPnlPct = startCap > 0 ? (pPnl / startCap) * 100 : 0;
        const pReserved = (p.sides?.Up?.restingCost||0) + (p.sides?.Down?.restingCost||0);
        const pTrades = (p.wins||0) + (p.losses||0);
        const pWinRate = pTrades > 0 ? ((p.wins||0) / pTrades * 100) : null;
        return '<div class="pair-card">'+
          '<div class="pair-hdr"><div class="pair-sym">'+p.symbol+' (5M Market)</div><div style="display:flex;gap:6px;align-items:center;"><div class="pair-mode-chip '+(p.mode==='weekend'?'weekend':'weekday')+'">'+(p.mode==='weekend'?'WEEKEND':'FILTER')+'</div><div class="pair-phase">'+p.phase+'</div><div class="pair-timer">'+fmtSecs(p.secsToEnd)+'</div></div></div>'+
          '<div class="pair-body">'+
            '<div class="pair-row"><span class="pair-key">Up Ask/Bid</span><span>'+(p.upAsk?.toFixed(2)||'—')+' / '+(p.upBid?.toFixed(2)||'—')+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Down Ask/Bid</span><span>'+(p.downAsk?.toFixed(2)||'—')+' / '+(p.downBid?.toFixed(2)||'—')+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Starting Capital</span><span>$'+startCap.toFixed(2)+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Current Equity</span><span>$'+(p.markValue||0).toFixed(2)+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">P&amp;L ($ / %)</span><span class="'+pClass(pPnl)+'">'+sgn(pPnl)+' ('+pctStr(pPnlPct)+')</span></div>'+
            '<div class="pair-row"><span class="pair-key">Realized / Unrealized</span><span class="'+pClass(p.realizedPnl)+'">'+sgn(p.realizedPnl)+'</span> / <span class="'+pClass(p.unrealizedPnl)+'">'+sgn(p.unrealizedPnl)+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Cash / Reserved</span><span>$'+(p.bankroll||0).toFixed(2)+' / $'+pReserved.toFixed(2)+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Fees / Rebates</span><span>$'+(p.feesPaid||0).toFixed(4)+' / $'+(p.rebatesEarned||0).toFixed(4)+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Win Rate</span><span>'+(pWinRate!=null?pWinRate.toFixed(0)+'%':'—')+' ('+p.wins+'W / '+p.losses+'L)</span></div>'+
            '<div class="pair-row"><span class="pair-key">Active Side / TP</span><span>'+(p.activeSides&&p.activeSides.length?p.activeSides.join(' + '):'NONE — sitting out')+' @ $'+(p.tpPrice!=null?p.tpPrice.toFixed(2):'—')+'</span></div>'+
            '<div class="pair-row"><span class="pair-key">Last Window Winner</span><span>'+(p.lastWinnerSide||'—')+'</span></div>'+
            '<div class="side-grid">'+sideBox('UP','up',p.sides?.Up, !p.activeSides || p.activeSides.includes('Up'))+sideBox('DOWN','down',p.sides?.Down, !p.activeSides || p.activeSides.includes('Down'))+'</div>'+
          '</div></div>';
      }).join('');
    }

    const tb = document.getElementById('trade-body');
    if (s.trades && s.trades.length > 0) {
      tb.innerHTML = s.trades.map(t => {
        return '<tr><td>'+t.time+'</td><td>'+t.symbol+'</td><td>'+t.outcome+'</td><td>'+(t.reason||'')+'</td><td>'+(t.price||0).toFixed(3)+'</td><td>'+(t.shares||0).toFixed(2)+'</td></tr>';
      }).join('');
    } else {
      tb.innerHTML = '<tr><td colspan="6" class="empty">No executions recorded yet</td></tr>';
    }

    const logEl = document.getElementById('logs');
    if (s.logs && s.logs.length > 0) {
      logEl.innerHTML = s.logs.map(l => {
        const col = l.includes('❌') ? '#ff4757' : l.includes('✅') || l.includes('💰') ? '#00e676' : '#00d4ff';
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
if (!PK) { console.error('❌ PRIVATE_KEY environment variable missing'); process.exit(1); }

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard Online: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Initialization failure:', e.message);
    process.exit(1);
  });
});
