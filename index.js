'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bot        = require('./cricket-bot');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 8080;

app.use(express.json());

app.get('/healthz', (_, res) => res.sendStatus(200));

app.get('/api/hedge/status', (_, res) => {
  try { res.json(bot.buildState()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (req, res) => {
  try { res.json(bot.pauseTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/resume', (req, res) => {
  try { res.json(bot.resumeTrading()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/set-mode', (req, res) => {
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
<title>⛏ BTC 0.60 Martingale — 5m &amp; 15m</title>
<style>
  :root {
    --bg: #ffffff; --bg2: #f5f7fa; --bg3: #edf0f4; --border: #d0d7e2;
    --text: #1a2535; --muted: #7a8fa8; --cyan: #0099cc; --green: #00a854;
    --red: #e8304a; --yellow: #e6a800; --gold: #b8860b; --purple: #7c5cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Courier New', monospace; background: var(--bg); color: var(--text); font-size: 12px; min-height: 100vh; font-weight: bold; }
  .header { background: linear-gradient(135deg,#0d1d30,#16283f); border-bottom: 3px solid var(--gold); padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
  .logo { font-size: 19px; font-weight: bold; color: #fff; letter-spacing: .5px; }
  .logo span { color: var(--cyan); }
  .mode-badge { padding: 4px 14px; border-radius: 20px; font-size: 11px; font-weight: bold; }
  .mode-dry { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
  .mode-live { background: #ff475722; color: #ff6b7a; border: 1px solid #ff4757; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  .toolbar { display: flex; gap: 8px; padding: 14px 20px 0; flex-wrap: wrap; align-items: center; }
  .toolbar button { background: var(--cyan); color: #001018; border: none; padding: 10px 16px; border-radius: 8px; font-weight: bold; cursor: pointer; font-family: inherit; font-size: 12px; }
  .toolbar button.pause { background: var(--yellow); }
  .toolbar button.resume { background: var(--green); color: #fff; }
  .toolbar button.live-toggle { background: var(--red); color: #fff; }
  .toolbar button.live-toggle.is-live { background: var(--muted); color: #fff; }
  .toolbar-note { padding: 6px 20px 0; font-size: 9.5px; color: var(--muted); }
  .shared-stats { display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; padding: 12px 20px 0; }
  @media (max-width: 1100px) { .shared-stats { grid-template-columns: repeat(4, 1fr); } }
  @media (max-width: 640px) { .shared-stats { grid-template-columns: repeat(2, 1fr); } }
  .stat { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 9px; }
  .stat-label { font-size: 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
  .stat-val { font-size: 13px; font-weight: bold; color: #12202e; }
  .pnl-pos { color: var(--green) !important; }
  .pnl-neg { color: var(--red) !important; }
  .chart-card { margin: 12px 20px 0; background: var(--bg2); border: 2px solid var(--border); border-radius: 12px; overflow: hidden; }
  .chart-hdr { background: #0d1d30; padding: 9px 14px; display: flex; justify-content: space-between; align-items: center; }
  .chart-title { font-size: 13px; color: #ddd; }
  .chart-meta { font-size: 9px; color: var(--muted); }
  .equity-chart { display: block; width: 100%; height: 220px; background: #fff; }
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 14px 20px; }
  @media (max-width: 900px) { .panels { grid-template-columns: 1fr; } }
  .panel { background: var(--bg2); border: 2px solid var(--border); border-radius: 12px; overflow: hidden; }
  .panel-hdr { background: #0d1d30; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; }
  .panel-title { font-size: 14px; color: #ddd; }
  .panel-body { padding: 12px 14px; }
  .stats-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 10px; }
  @media (max-width: 560px) { .stats-row { grid-template-columns: repeat(2, 1fr); } }
  .current-window { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 10px; margin-bottom: 10px; }
  .current-window .headline { font-size: 12.5px; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px dashed var(--border); }
  .current-window .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .status-pill { font-size: 8.5px; padding: 2px 7px; border-radius: 9px; white-space: nowrap; }
  .status-wait { background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
  .status-resting { background: #e6a80022; color: var(--gold); border: 1px solid var(--gold); }
  .status-open { background: #0099cc22; color: var(--cyan); border: 1px solid var(--cyan); }
  .status-win { background: #00a85422; color: var(--green); border: 1px solid var(--green); }
  .status-loss { background: #e8304a22; color: var(--red); border: 1px solid var(--red); }
  .status-idle { background: var(--bg3); color: var(--muted); border: 1px solid var(--border); }
  .ladder { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 8px 0; }
  .lvl { border: 1px dashed var(--border); border-radius: 8px; padding: 6px 4px; text-align: center; font-size: 8.5px; background: var(--bg2); }
  .lvl .lvl-tag { color: var(--muted); text-transform: uppercase; font-size: 7px; letter-spacing: .4px; }
  .lvl .lvl-amt { font-size: 11px; margin: 2px 0; }
  .lvl .lvl-side { font-size: 9px; min-height: 11px; }
  .lvl .lvl-px { font-size: 8px; color: var(--muted); min-height: 10px; }
  .lvl.active { border: 2px solid var(--cyan); background: #0099cc11; }
  .lvl.placed.up { border: 2px solid var(--cyan); background: #0099cc22; }
  .lvl.placed.down { border: 2px solid var(--purple); background: #7c5cff22; }
  .tbl-wrap { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; max-height: 240px; overflow-y: auto; }
  .tbl { width: 100%; border-collapse: collapse; }
  .tbl th { background: var(--bg3); color: var(--muted); padding: 5px 6px; text-align: left; font-size: 8px; text-transform: uppercase; position: sticky; top: 0; }
  .tbl td { padding: 4px 6px; border-bottom: 1px solid var(--border); font-size: 9px; }
  .empty { padding: 16px; text-align: center; color: var(--muted); font-size: 9.5px; }
  .log-panel { background: #0d1420; color: #cfe8ff; border-radius: 10px; padding: 10px 12px; max-height: 240px; overflow-y: auto; font-size: 9.5px; margin: 0 20px 20px; }
  .log-panel div { padding: 1px 0; }
  .start-banner { margin: 10px 20px 0; padding: 8px 14px; border-radius: 8px; font-size: 10.5px; background: #ffd74022; color: var(--yellow); border: 1px solid var(--yellow); }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">⛏ <span>BTC</span> 0.60 MARTINGALE — 5m &amp; 15m</div>
    <div id="mode-badge" class="mode-badge mode-dry">DEMO</div>
  </div>

  <div class="toolbar">
    <button id="pause-btn" class="pause">⏸️ Pause Trading</button>
    <button id="resume-btn" class="resume">▶️ Resume Trading</button>
    <button id="live-btn" class="live-toggle">🔴 Switch to LIVE</button>
  </div>
  <div class="toolbar-note">Strategy: wait 1m (5m) / 3m (15m) after open → fire the $50 entry on the LEADING side at ANY price → ONE $100 flip INSTANTLY when the opposite side reaches 0.50 (no flips after 280s / 870s). Flip FIRST, then sell the losing side ~2s later at the bid. 5m and 15m run on SEPARATE demo capital. At window end, the side above 0.90 wins.</div>
  <div id="start-banner" class="start-banner" style="display:none;"></div>

  <div class="shared-stats" id="shared-stats"></div>

  <div class="chart-card">
    <div class="chart-hdr">
      <div class="chart-title">📈 Equity Curve (peak → trough → recovery)</div>
      <div id="chart-meta" class="chart-meta"></div>
    </div>
    <canvas id="equity-chart" class="equity-chart"></canvas>
  </div>

  <div class="panels">
    <div class="panel" id="panel-m5"></div>
    <div class="panel" id="panel-m15"></div>
  </div>

  <div class="log-panel" id="log-panel"><div class="empty">No logs yet</div></div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  let latest = { m5: null, m15: null };
  function $(id) { return document.getElementById(id); }
  function fmt2(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(2); }
  function fmtPx(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(3); }
  function fmtPct(n) { return (n == null || isNaN(n)) ? '—' : (Number(n) * 100).toFixed(1) + '%'; }
  function sgn(n) { if (n == null || isNaN(n)) return '—'; return (n > 0 ? '+$' : (n < 0 ? '-$' : '±$')) + Math.abs(n).toFixed(2); }
  function pClass(n) { if (n == null || isNaN(n)) return ''; return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }
  function fmtClock(ts) { if (!ts) return '—'; const d = new Date(ts * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); }
  function fmtCountdown(ms) { if (ms == null) return '—'; const s = Math.max(0, Math.ceil(ms / 1000)); const m = Math.floor(s / 60); const ss = s % 60; return m + ':' + String(ss).padStart(2, '0'); }

  function stat(label, value, cls) {
    return '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-val ' + (cls || '') + '">' + value + '</div></div>';
  }

  function phaseInfo(t) {
    if (!t) return { label: '—', cls: 'status-idle' };
    if (t.skipped) return { label: 'NO BET', cls: 'status-idle' };
    if (t.settled) return { label: t.win === true ? 'WIN' : (t.win === false ? 'LOSS' : 'RESOLVED'), cls: t.win === true ? 'status-win' : (t.win === false ? 'status-loss' : 'status-idle') };
    switch (t.phase) {
      case 'waiting': return { label: 'WAITING ' + fmtCountdown(t.countdownMs), cls: 'status-wait' };
      case 'awaiting-trigger': return { label: 'FIRING ENTRY', cls: 'status-open' };
      case 'trading': return { label: 'TRADING · MG ' + t.martingaleLevel, cls: 'status-open' };
      case 'pending-resolution': return { label: 'RESOLVING…', cls: 'status-resting' };
      default: return { label: String(t.phase).toUpperCase(), cls: 'status-idle' };
    }
  }

  function ladderHtml(s, t) {
    const levels = [{ d: s.entryDollars, tag: 'ENTRY' }];
    (s.martingaleAmounts || []).forEach((d, i) => levels.push({ d: d, tag: 'MG' + (i + 1) }));
    let html = '<div class="ladder">';
    for (let i = 0; i < levels.length; i++) {
      const buy = t.buys && t.buys[i];
      let cls = 'lvl';
      if (buy) cls += ' placed ' + (buy.side === 'up' ? 'up' : 'down');
      else if (t.buys && t.buys.length === i && (t.phase === 'trading' || t.phase === 'awaiting-trigger')) cls += ' active';
      const side = buy ? (buy.side === 'up' ? 'UP' : 'DOWN') : (t.buys && t.buys.length === i && t.phase === 'trading' ? '…' : '—');
      const px = buy ? fmtPx(buy.price) : (t.buys && t.buys.length === i && t.phase === 'trading' ? 'watch 0.50' : '');
      const tip = levels[i].tag + ' $' + levels[i].d + (buy ? ' — ' + buy.side.toUpperCase() + ' @' + fmtPx(buy.price) + ' = ' + fmt2(buy.shares) + 'sh' : '');
      html += '<div class="' + cls + '" title="' + tip + '">' +
        '<div class="lvl-tag">' + levels[i].tag + '</div>' +
        '<div class="lvl-amt">$' + levels[i].d + '</div>' +
        '<div class="lvl-side">' + side + '</div>' +
        '<div class="lvl-px">' + px + '</div></div>';
    }
    return html + '</div>';
  }

  function currentWindowHtml(s) {
    const t = s.current.btc;
    if (!t) return '<div class="empty">Waiting for window…</div>';
    const ph = phaseInfo(t);
    const leg = t.leg || {};
    const hasBuys = t.buys && t.buys.length > 0;
    let headline;
    if (t.skipped) headline = '⏸ No bet placed this window';
    else if (t.settled) headline = (t.win === true ? '🏆' : (t.win === false ? '💸' : '🏁')) + ' Window resolved — ' + (t.win == null ? 'no bet' : (t.win ? 'WIN' : 'LOSS')) + ' ' + sgn(t.pnl);
    else if (t.phase === 'waiting') headline = '⏳ Waiting ' + fmtCountdown(t.countdownMs) + ' — then fire the $' + s.entryDollars + ' entry on the leading side (any price)';
    else if (t.phase === 'awaiting-trigger') headline = '🎯 Firing the $' + s.entryDollars + ' entry on the leading side (any price)';
    else headline = (t.lastSide === 'up' ? '🔵' : '🟣') + ' Trading ' + (t.lastSide || '?').toUpperCase() + ' — flipping if the opposite side hits 0.50';
    let html = '<div class="current-window">' +
      '<div class="headline">' + headline + '</div>' +
      '<div class="row"><span>Window</span><span>' + (leg.slug || '…') + '</span></div>' +
      '<div class="row"><span>Phase</span><span class="status-pill ' + ph.cls + '">' + ph.label + '</span></div>' +
      '<div class="row"><span>Closes in</span><span>' + fmtCountdown(t.closeAt - Date.now()) + '</span></div>' +
      '<div class="row"><span>UP price (ask / bid)</span><span>' + fmtPx(leg.upAsk) + ' / ' + fmtPx(leg.upBid) + '</span></div>' +
      '<div class="row"><span>DOWN price (ask / bid)</span><span>' + fmtPx(leg.downAsk) + ' / ' + fmtPx(leg.downBid) + '</span></div>' +
      '<div class="row"><span>Flip trigger</span><span>opposite side ≥ ' + fmtPx(s.flipTriggerPrice || 0.5) + ' (instant) · entry: leading side @ any price</span></div>' +
      ladderHtml(s, t);
    if (hasBuys) {
      const lastBuy = t.buys[t.buys.length - 1];
      html += '<div class="row"><span>Current side / leg</span><span>' + lastBuy.side.toUpperCase() + ' — $' + fmt2(lastBuy.dollars) + ' @' + fmtPx(lastBuy.price) + ' (' + fmt2(lastBuy.shares) + 'sh)</span></div>' +
        '<div class="row"><span>Total risked (cost)</span><span>$' + fmt2(t.totalCost) + '</span></div>' +
        '<div class="row"><span>Recovered (losing-side sells)</span><span>$' + fmt2(t.sellProceeds || 0) + '</span></div>' +
        (t.pendingSells && t.pendingSells.length ? '<div class="row"><span>Pending sells</span><span>' + t.pendingSells.length + ' (' + t.pendingSells.map(x => x.side.slice(0, 1).toUpperCase()).join(', ') + ')</span></div>' : '');
      if (t.settled) {
        html += '<div class="row"><span>Final P&amp;L</span><span class="' + pClass(t.pnl) + '">' + sgn(t.pnl) + '</span></div>';
      } else {
        html += '<div class="row"><span>Unrealized P&amp;L</span><span class="' + pClass(t.unrealizedPnl) + '">' + sgn(t.unrealizedPnl) + '</span></div>';
      }
    }
    return html + '</div>';
  }

  function historyRowsHtml(list) {
    if (!list || !list.length) return '<tr><td colspan="10" class="empty">No resolved windows yet</td></tr>';
    return list.slice(0, 25).map(function (h) {
      const legTxt = (h.legs || []).map(l => l.side.toUpperCase() + ' $' + l.dollars + ' @' + fmtPx(l.price) + ' = ' + fmt2(l.shares) + 'sh').join(' → ');
      const sellTxt = (h.sells || []).map(x => x.side.toUpperCase() + ' ' + fmt2(x.shares) + 'sh@' + fmtPx(x.price)).join(', ') || 'none';
      const entry = h.entrySide ? h.entrySide.toUpperCase() + ' $' + (h.legs && h.legs[0] ? h.legs[0].dollars : '') : '—';
      return '<tr title="' + legTxt + ' | sells: ' + sellTxt + '">' +
        '<td>' + fmtClock(h.windowTs) + '</td>' +
        '<td>' + entry + '</td>' +
        '<td>' + (h.martingaleLevels || 0) + '</td>' +
        '<td>' + (h.reachedMaxMartingale ? '✓' : '—') + '</td>' +
        '<td>' + (h.winner || '?').toUpperCase() + '</td>' +
        '<td class="' + (h.win === true ? 'pnl-pos' : (h.win === false ? 'pnl-neg' : '')) + '">' + (h.win == null ? '—' : (h.win ? 'WIN' : 'LOSS')) + '</td>' +
        '<td>-$' + fmt2(h.wager || 0) + '</td>' +
        '<td>+$' + fmt2(h.payout || 0) + '</td>' +
        '<td>' + (h.sells ? h.sells.length : 0) + ' · $' + fmt2(h.sellProceeds || 0) + '</td>' +
        '<td class="' + pClass(h.pnl) + '">' + sgn(h.pnl) + '</td></tr>';
    }).join('');
  }

  function panelHtml(key, title, s) {
    if (!s) return '<div class="panel-hdr"><div class="panel-title">' + title + '</div></div><div class="panel-body"><div class="empty">Waiting for data…</div></div>';
    return '<div class="panel-hdr">' +
        '<div class="panel-title">' + title + '</div>' +
        '<div class="mode-badge ' + (s.dryRun ? 'mode-dry' : 'mode-live') + '" style="font-size:9px;">' + (s.dryRun ? 'DEMO' : 'LIVE') + '</div>' +
      '</div>' +
      '<div class="panel-body">' +
        '<div class="stats-row">' +
          stat('Bankroll', '$' + fmt2(s.bankroll)) +
          stat('Equity', '$' + fmt2(s.equity), pClass(s.equity - (s.startingCapital || 0))) +
          stat('Win Rate', fmtPct(s.winRate)) +
          stat('Realized P&amp;L', sgn(s.realizedPnl), pClass(s.realizedPnl)) +
          stat('Wins / Losses', s.wins + ' / ' + s.losses) +
          stat('Max Drawdown', fmtPct((s.maxDrawdown || {}).pct) + ' · ' + sgn(-((s.maxDrawdown || {}).dollars || 0)), pClass(-((s.maxDrawdown || {}).dollars || 0))) +
          stat('Reached Max MG ($100)', s.windowsReachedMaxMartingale) +
        '</div>' +
        currentWindowHtml(s) +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Window</th><th>Entry</th><th>Legs</th><th>MaxMG</th><th>Winner</th><th>W/L</th><th>Cost</th><th>Payout</th><th>Sells (rec.)</th><th>PnL</th></tr></thead>' +'<tbody>' + historyRowsHtml(s.history) + '</tbody></table></div>' +
      '</div>';
  }

  function drawdownOf(curve) {
    let peak = -Infinity; let maxPct = 0; let maxDollars = 0;
    for (const p of curve) {
      if (p.equity > peak) peak = p.equity;
      const dd = peak > 0 ? (peak - p.equity) / peak : 0;
      if (dd > maxPct) { maxPct = dd; maxDollars = peak - p.equity; }
    }
    return { pct: maxPct, dollars: maxDollars };
  }
  function combinedCurve() {
    const a = latest.m15; const b = latest.m5;
    const c15 = a && a.equityCurve; const c5 = b && b.equityCurve;
    if (!c5 || !c15) return (c5 || c15 || []);
    const n = Math.min(c5.length, c15.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ t: c5[i].t, equity: Math.round((c5[i].equity + c15[i].equity) * 100) / 100 });
    return out;
  }
  function sharedStatsHtml() {
    const a = latest.m15;
    const b = latest.m5;
    if (!a && !b) return '';
    const bankroll = (a ? a.bankroll : 0) + (b ? b.bankroll : 0);
    const equity = (a ? a.equity : 0) + (b ? b.equity : 0);
    const rpnl = (a ? a.realizedPnlTotal : 0) + (b ? b.realizedPnlTotal : 0);
    const decided = (a ? a.windowsDecided : 0) + (b ? b.windowsDecided : 0);
    const wins = (a ? a.wins : 0) + (b ? b.wins : 0);
    const winRate = decided > 0 ? wins / decided : null;
    const m3 = (a ? a.windowsReachedMaxMartingale : 0) + (b ? b.windowsReachedMaxMartingale : 0);
    const dd = drawdownOf(combinedCurve());
    const fees = (a ? a.totalFeesPaid : 0) + (b ? b.totalFeesPaid : 0);
    return stat('Total Bankroll (5m + 15m)', '$' + fmt2(bankroll)) +
      stat('Total Equity', '$' + fmt2(equity)) +
      stat('Total Realized P&amp;L', sgn(rpnl), pClass(rpnl)) +
      stat('Win Rate', fmtPct(winRate)) +
      stat('Windows Decided', decided) +
      stat('Reached Max Martingale', m3) +
      stat('Max Drawdown (combined)', fmtPct(dd.pct) + ' · ' + sgn(dd.dollars), pClass(-(dd.dollars || 0))) +
      stat('Fees Paid', '$' + fmt2(fees));
  }

  function drawEquityChart() {
    const canvas = $('equity-chart');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 800;
    const H = canvas.clientHeight || 220;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const m5 = latest.m5;
    const m15 = latest.m15;
    const series = [
      { label: '5m', st: m5, color: '#0099cc', fill: 'rgba(0,153,204,0.08)' },
      { label: '15m', st: m15, color: '#ff9f43', fill: 'rgba(255,159,67,0.10)' },
    ].filter(x => x.st && x.st.equityCurve && x.st.equityCurve.length >= 2);
    if (!series.length) {
      ctx.fillStyle = '#7a8fa8';
      ctx.font = '10px monospace';
      ctx.fillText('Collecting equity data…', 14, 24);
      $('chart-meta').textContent = '';
      return;
    }
    let min = Infinity; let max = -Infinity;
    for (const x of series) {
      for (const p of x.st.equityCurve) { if (p.equity < min) min = p.equity; if (p.equity > max) max = p.equity; }
      min = Math.min(min, x.st.startingCapital); max = Math.max(max, x.st.startingCapital);
    }
    const pad = 10;
    const xAt = (i, len) => pad + (i / (len - 1)) * (W - pad * 2);
    const yAt = v => H - pad - ((v - min) / ((max - min) || 1)) * (H - pad * 2);
    ctx.strokeStyle = '#e3e8f0';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gy = pad + (g / 4) * (H - pad * 2);
      ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke();
    }
    const metas = [];
    for (const x of series) {
      const curve = x.st.equityCurve;
      const vals = curve.map(p => p.equity);
      // start line
      ctx.strokeStyle = x.color;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      const sy = yAt(x.st.startingCapital);
      ctx.moveTo(pad, sy); ctx.lineTo(W - pad, sy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // line + fill
      ctx.beginPath();
      ctx.moveTo(xAt(0, curve.length), yAt(vals[0]));
      for (let i = 1; i < curve.length; i++) ctx.lineTo(xAt(i, curve.length), yAt(vals[i]));
      ctx.strokeStyle = x.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineTo(xAt(curve.length - 1, curve.length), H - pad);
      ctx.lineTo(xAt(0, curve.length), H - pad);
      ctx.closePath();
      ctx.fillStyle = x.fill;
      ctx.fill();
      // end marker
      ctx.fillStyle = x.color;
      ctx.beginPath(); ctx.arc(xAt(curve.length - 1, curve.length), yAt(vals[curve.length - 1]), 3.5, 0, Math.PI * 2); ctx.fill();
      const dd = x.st.maxDrawdown || {};
      metas.push(x.label + ': $' + fmt2(x.st.startingCapital) + ' → $' + fmt2(vals[curve.length - 1]) + ' · DD ' + fmtPct(dd.pct) + ' (' + sgn(-(dd.dollars || 0)) + ')');
    }
    ctx.font = '9px monospace';
    ctx.fillStyle = '#7a8fa8';
    ctx.fillText('$' + fmt2(max), 12, 14);
    ctx.fillText('$' + fmt2(min), 12, H - 4);
    $('chart-meta').textContent = metas.join('   |   ');
  }

  function render() {
    const any = latest.m5 || latest.m15;
    const banner = $('start-banner');
    if (any && any.waitingForBoundary && any.boundaryWindowTs) {
      banner.style.display = 'block';
      banner.textContent = '⏳ Starting at the next 15m boundary (' + fmtClock(any.boundaryWindowTs) + ' UTC) — no windows are open yet.';
    } else {
      banner.style.display = 'none';
    }
    $('shared-stats').innerHTML = sharedStatsHtml();
    $('panel-m5').innerHTML = panelHtml('m5', 'BTC 5-Minute — wait 1 min', latest.m5);
    $('panel-m15').innerHTML = panelHtml('m15', 'BTC 15-Minute — wait 3 min', latest.m15);
    drawEquityChart();
    if (any) {
      const anyLive = (latest.m5 && !latest.m5.dryRun) || (latest.m15 && !latest.m15.dryRun);
      $('mode-badge').className = 'mode-badge ' + (anyLive ? 'mode-live' : 'mode-dry');
      $('mode-badge').textContent = anyLive ? 'LIVE' : 'DEMO';
      $('live-btn').classList.toggle('is-live', anyLive);
      $('live-btn').textContent = anyLive ? '⚠️ Switch to DEMO' : '🔴 Switch to LIVE';
    }
  }

  $('pause-btn').onclick = () => fetch('/api/hedge/pause', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  $('resume-btn').onclick = () => fetch('/api/hedge/resume', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  $('live-btn').onclick = () => {
    const anyLive = (latest.m5 && !latest.m5.dryRun) || (latest.m15 && !latest.m15.dryRun);
    const wantLive = !anyLive;
    if (wantLive && !confirm('Switch to LIVE mode? This will place REAL money orders on the BTC 5-minute and 15-minute Up/Down markets.')) return;
    fetch('/api/hedge/set-mode', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ live: wantLive }) });
  };

  const allLogs = [];
  function renderLogs() {
    const el = $('log-panel');
    if (!allLogs.length) { el.innerHTML = '<div class="empty">No logs yet</div>'; return; }
    el.innerHTML = allLogs.slice(-120).map(l => '<div>' + l.replace(/</g, '&lt;') + '</div>').join('');
    el.scrollTop = el.scrollHeight;
  }

  socket.on('hedgeState:BTC-5m', (s) => { latest.m5 = s; render(); });
  socket.on('hedgeState:BTC-15m', (s) => { latest.m15 = s; render(); });
  socket.on('log', (line) => { allLogs.push(line); if (allLogs.length > 300) allLogs.shift(); renderLogs(); });

  setInterval(render, 1000);
  setInterval(async () => {
    try {
      const res = await fetch('/api/hedge/status');
      const st = await res.json();
      if (st && st.m5) latest.m5 = st.m5;
      if (st && st.m15) latest.m15 = st.m15;
      render();
    } catch (_) {}
  }, 10000);
  render();
</script>
</body>
</html>`);
});

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log('⛏ BTC 0.60 Martingale Bot — 5m & 15m windows, separate demo capital per timeframe');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  bot.init(PK, emit, slog).catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
