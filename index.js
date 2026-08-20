'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const PolymarketTrader = require('./polymarket-trader');
const { createEngine } = require('./engine-factory');

const DRY_RUN = (process.env.HEDGE_DRY_RUN || process.env.SPORTS_DRY_RUN || process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const CAPITAL_5 = Number(process.env.CAPITAL_5 || process.env.CAPITAL || 4000);
const CAPITAL_15 = Number(process.env.CAPITAL_15 || 4000);
const ENTRY_PRICE = Number(process.env.ENTRY_PRICE || 0.60);
const STOP_LOSS_PRICE = Number(process.env.STOP_LOSS_PRICE || 0.49);
const ENTRY_DOLLARS = Number(process.env.ENTRY_DOLLARS || 50);
const MARTINGALE_MULTIPLIER = Number(process.env.MARTINGALE_MULTIPLIER || 1.5);
const MAX_MARTINGALE_LEVELS = Number(process.env.MAX_MARTINGALE_LEVELS || 1);
const WAIT_SECONDS_5 = Number(process.env.WAIT_SECONDS_5 || 0);
const WAIT_SECONDS_15 = Number(process.env.WAIT_SECONDS_15 || 0);
const FEE_THETA = Number(process.env.FEE_THETA || 0.07);
const REBATE_PCT = Number(process.env.REBATE_PCT || 0);

let engine5 = null, engine5s = null, engine15 = null, engine15s = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 2000, pingTimeout: 5000 });
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.get('/healthz', (_, r) => r.sendStatus(200));
app.get('/api/hedge/status', (_, r) => {
  try { r.json({ m5: engine5 ? engine5.buildState() : null, m5s: engine5s ? engine5s.buildState() : null, m15: engine15 ? engine15.buildState() : null, m15s: engine15s ? engine15s.buildState() : null }); }
  catch (e) { r.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/hedge/pause', (_, r) => { try { if (engine5) engine5.pauseTrading(); if (engine5s) engine5s.pauseTrading(); if (engine15) engine15.pauseTrading(); if (engine15s) engine15s.pauseTrading(); r.json({ ok: true }); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });
app.post('/api/hedge/resume', (_, r) => { try { if (engine5) engine5.resumeTrading(); if (engine5s) engine5s.resumeTrading(); if (engine15) engine15.resumeTrading(); if (engine15s) engine15s.resumeTrading(); r.json({ ok: true }); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });
app.post('/api/hedge/set-mode', (req, r) => { const { live } = req.body || {}; if (typeof live !== 'boolean') return r.status(400).json({ ok: false, error: 'Missing "live" boolean' }); try { if (engine5) engine5.setMode(live); if (engine5s) engine5s.setMode(live); if (engine15) engine15.setMode(live); if (engine15s) engine15s.setMode(live); r.json({ ok: true }); } catch (e) { r.status(500).json({ ok: false, error: e.message }); } });

const DASH = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>BTC Martingale Bot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Courier New',monospace;background:#000;color:#fff;font-size:12px;font-weight:bold;-webkit-text-size-adjust:100%;overflow-x:hidden}
.hd{background:linear-gradient(135deg,#0d1d30,#16283f);border-bottom:3px solid #ffaa00;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.logo{font-size:16px;color:#fff}.logo span{color:#00ccff}
.badge{padding:3px 10px;border-radius:20px;font-size:10px;font-weight:bold}
.badge-dem{background:#ffd74022;color:#ffcc00;border:1px solid #ffcc00}
.badge-live{background:#ff475722;color:#ff6b7a;border:1px solid #ff4757;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.btns{display:flex;gap:6px;padding:8px 14px 0;flex-wrap:wrap}
.btns button{background:#00ccff;color:#001018;border:none;padding:6px 10px;border-radius:6px;font-weight:bold;cursor:pointer;font-family:inherit;font-size:11px}
.btns button.pause{background:#ffcc00;color:#000}
.btns button.resume{background:#00ff88;color:#000}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px 14px 0}
@media(max-width:600px){.stats-row{grid-template-columns:repeat(2,1fr);gap:5px;padding:8px 10px 0}}
.st{background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:6px 7px}
.st-l{font-size:7px;color:#888;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.st-v{font-size:13px;font-weight:bold;color:#fff}
.pos{color:#00ff88!important}.neg{color:#ff4444!important}
.panel{margin:8px 14px 0;background:#0a0a0a;border:2px solid #333;border-radius:10px;overflow:hidden}
.duo{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 14px 0}
@media(max-width:700px){.duo{grid-template-columns:1fr}}
@media(max-width:600px){.panel{margin:6px 10px 0}}
.p-hd{background:#0d1d30;padding:8px 12px;display:flex;justify-content:space-between;align-items:center}
.p-title{font-size:14px;font-weight:bold;color:#fff}
.p-badge{font-size:9px;padding:2px 8px;border-radius:10px;background:#333;color:#aaa}
.p-body{padding:10px 12px}
.p-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px}
@media(max-width:600px){.p-stats{grid-template-columns:repeat(2,1fr)}}
.ps{background:#111;border:1px solid #333;border-radius:5px;padding:4px 6px}
.ps .l{font-size:7px;color:#888;text-transform:uppercase}
.ps .v{font-size:12px;font-weight:bold;color:#fff}
.price-box{background:#111;border:1px solid #444;border-radius:8px;padding:8px 10px;margin-bottom:8px}
.price-row{display:flex;justify-content:space-between;align-items:center}
.price-side{font-size:11px;font-weight:bold}
.price-side.up{color:#00ccff}.price-side.dn{color:#aa88ff}
.price-val{font-size:18px;font-weight:bold;color:#fff}
.price-val.up{color:#00ccff}.price-val.dn{color:#aa88ff}
.price-label{font-size:7px;color:#888;text-transform:uppercase}
.current-win{background:#111;border:1px solid #333;border-radius:8px;padding:10px;margin-bottom:8px}
.cw-phase{font-size:13px;font-weight:bold;color:#ffcc00;margin-bottom:6px}
.cw-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.cw-item .lbl{color:#888;font-size:7px;text-transform:uppercase}
.cw-item .val{font-size:14px;font-weight:bold;color:#fff}
.trade-card{background:#111;border:1px solid #444;border-radius:6px;padding:8px 10px;margin-bottom:6px}
.tc-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.tc-level{font-size:9px;padding:2px 6px;border-radius:4px;font-weight:bold}
.tc-base{background:#00ccff22;color:#00ccff;border:1px solid #00ccff}
.tc-mart{background:#ffcc0022;color:#ffcc00;border:1px solid #ffcc00}
.tc-side{font-size:12px;font-weight:bold}
.tc-side.up{color:#00ccff}.tc-side.dn{color:#aa88ff}
.tc-details{display:flex;gap:14px;flex-wrap:wrap}
.tc-detail .lbl{color:#666;font-size:7px;text-transform:uppercase}
.tc-detail .val{font-size:14px;font-weight:bold;color:#fff}
.history-list{max-height:300px;overflow-y:auto}
.h-item{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #1a1a1a;font-size:9px;gap:6px}
.h-result{font-size:10px;font-weight:bold;padding:1px 5px;border-radius:3px}
.h-win{background:#00ff8822;color:#00ff88}
.h-loss{background:#ff444422;color:#ff4444}
.h-skip{background:#88888822;color:#888}
.h-pnl{font-size:11px;font-weight:bold}
.log-box{margin:8px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:8px 10px;max-height:200px;overflow-y:auto;font-size:9px;line-height:1.4;white-space:nowrap;-webkit-overflow-scrolling:touch}
@media(max-width:600px){.log-box{margin:6px 10px 0}}
.log-box div{padding:1px 0}
.chart-box{margin:8px 14px 0;background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:10px 12px}
@media(max-width:600px){.chart-box{margin:6px 10px 0}}
.chart-box canvas{width:100%;height:120px;background:#111;border-radius:6px}
.section-hdr{font-size:8px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px}
</style></head><body>
<div class="hd"><div><div class="logo">Mining <span>BTC Martingale</span></div></div><div class="badge badge-dem" id="mode-badge">DEMO</div></div>
<div class="btns"><button onclick="fetch('/api/hedge/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})" class="pause">Pause</button><button onclick="fetch('/api/hedge/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})" class="resume">Resume</button></div>
<div class="stats-row" id="stats-row"></div>
<div class="chart-box"><canvas id="eq-chart"></canvas></div>
<div class="duo">
<div class="panel" id="panel-m5"><div class="p-hd"><div class="p-title">5m Regular</div><div class="p-badge" id="m5-badge">--</div></div><div class="p-body" id="m5-body"></div></div>
<div class="panel" id="panel-m5s" style="border-color:#ffaa00"><div class="p-hd"><div class="p-title">5m Skip <span style="font-size:9px;color:#ffaa00">SKIP 1ST</span></div><div class="p-badge" id="m5s-badge">--</div></div><div class="p-body" id="m5s-body"></div></div>
</div>
<div class="duo">
<div class="panel" id="panel-m15"><div class="p-hd"><div class="p-title">15m Regular</div><div class="p-badge" id="m15-badge">--</div></div><div class="p-body" id="m15-body"></div></div>
<div class="panel" id="panel-m15s" style="border-color:#ffaa00"><div class="p-hd"><div class="p-title">15m Skip <span style="font-size:9px;color:#ffaa00">SKIP 1ST</span></div><div class="p-badge" id="m15s-badge">--</div></div><div class="p-body" id="m15s-body"></div></div>
</div>
<div class="log-box" id="log-box"></div>
<script src="/socket.io/socket.io.js"></script>
<script>
var socket=io(),latest={m5:null,m15:null},allLogs=[];
var $=function(id){return document.getElementById(id)};
var fmt2=function(n){return n!=null?Number(n).toFixed(2):'--'};
var fmt3=function(n){return n!=null?Number(n).toFixed(3):'--'};
var sgn=function(n){return n>0?'+$'+fmt2(n):n<0?'-$'+fmt2(Math.abs(n)):'$0.00'};
var pC=function(n){return n>0?'pos':n<0?'neg':''};

function priceHtml(leg,label){
  if(!leg||!leg.discovered)return'';
  var upA=fmt3(leg.upAsk),upB=fmt3(leg.upBid),dnA=fmt3(leg.downAsk),dnB=fmt3(leg.downBid);
  return '<div class="price-box">'+
    '<div class="price-row">'+
      '<div><div class="price-label">UP ASK</div><div class="price-val up">'+upA+'</div></div>'+
      '<div><div class="price-label">UP BID</div><div class="price-val up">'+upB+'</div></div>'+
      '<div style="text-align:right"><div class="price-label">DOWN BID</div><div class="price-val dn">'+dnB+'</div></div>'+
      '<div style="text-align:right"><div class="price-label">DOWN ASK</div><div class="price-val dn">'+dnA+'</div></div>'+
    '</div></div>';
}

function panelHtml(st,label){
  if(!st)return'<div style="color:#666;padding:10px">Waiting for data...</div>';
  var h='';
  // Panel stats
  h+='<div class="p-stats">';
  h+='<div class="ps"><div class="l">Bankroll</div><div class="v">$'+fmt2(st.bankroll)+'</div></div>';
  h+='<div class="ps"><div class="l">Equity</div><div class="v '+pC(st.equity-st.startingCapital)+'">$'+fmt2(st.equity)+'</div></div>';
  h+='<div class="ps"><div class="l">Realized</div><div class="v '+pC(st.realizedPnl)+'">'+sgn(st.realizedPnl)+'</div></div>';
  h+='<div class="ps"><div class="l">Unrealized</div><div class="v '+pC(st.totalUnrealized)+'">'+sgn(st.totalUnrealized)+'</div></div>';
  h+='</div>';
  h+='<div class="p-stats">';
  h+='<div class="ps"><div class="l">Wins</div><div class="v pos">'+(st.wins||0)+'</div></div>';
  h+='<div class="ps"><div class="l">Losses</div><div class="v neg">'+(st.losses||0)+'</div></div>';
  h+='<div class="ps"><div class="l">Win Rate</div><div class="v">'+(st.winRate!=null?st.winRate+'%':'--')+'</div></div>';
  h+='<div class="ps"><div class="l">Max Mart</div><div class="v">'+(st.windowsReachedMaxMartingale||0)+'</div></div>';
  h+='</div>';

  // Current window
  var cur=st.current&&st.current.btc;
  if(cur&&cur.leg&&cur.leg.discovered){
    // Live prices — large and prominent
    h+=priceHtml(cur.leg,label);
    // Floating position summary
    if(cur.heldUp>0||cur.heldDown>0){
      h+='<div class="current-win">';
      h+='<div class="cw-phase">'+(cur.phase||'').toUpperCase()+' — '+(cur.secsLeft!=null?cur.secsLeft+'s left':'')+'</div>';
      h+='<div class="cw-row">';
      h+='<div class="cw-item"><div class="lbl">Total Cost</div><div class="val">$'+fmt2(cur.totalCost)+'</div></div>';
      h+='<div class="cw-item"><div class="lbl">MTM Value</div><div class="val">'+(cur.mtmTotal!=null?'$'+fmt2(cur.mtmTotal):'--')+'</div></div>';
      h+='<div class="cw-item"><div class="lbl">Unrealized</div><div class="val '+pC(cur.unrealizedPnl)+'">'+(cur.unrealizedPnl!=null?sgn(cur.unrealizedPnl):'--')+'</div></div>';
      h+='<div class="cw-item"><div class="lbl">Buys</div><div class="val">'+(cur.buys?cur.buys.length:0)+'</div></div>';
      h+='</div>';
      h+='<div class="cw-row">';
      if(cur.heldUp>0)h+='<div class="cw-item"><div class="lbl">UP Held</div><div class="val" style="color:#00ccff">'+cur.heldUp.toFixed(2)+'sh @'+fmt3(cur.upMark)+' = $'+fmt2(cur.mtmUp)+'</div></div>';
      if(cur.heldDown>0)h+='<div class="cw-item"><div class="lbl">DN Held</div><div class="val" style="color:#aa88ff">'+cur.heldDown.toFixed(2)+'sh @'+fmt3(cur.downMark)+' = $'+fmt2(cur.mtmDown)+'</div></div>';
      h+='</div></div>';
    } else {
      h+='<div class="current-win">';
      h+='<div class="cw-phase">'+(cur.phase||'').toUpperCase()+' — '+(cur.secsLeft!=null?cur.secsLeft+'s left':'')+'</div>';
      h+='<div class="cw-row">';
      h+='<div class="cw-item"><div class="lbl">Total Cost</div><div class="val">$'+fmt2(cur.totalCost)+'</div></div>';
      h+='<div class="cw-item"><div class="lbl">Buys</div><div class="val">'+(cur.buys?cur.buys.length:0)+'</div></div>';
      h+='<div class="cw-item"><div class="lbl">Mart Level</div><div class="val">'+(cur.martingaleLevel||0)+'</div></div>';
      if(cur.pnl!=null)h+='<div class="cw-item"><div class="lbl">P&L</div><div class="val '+pC(cur.pnl)+'">'+sgn(cur.pnl)+'</div></div>';
      h+='</div></div>';
    }
    // Trade cards
    if(cur.buys&&cur.buys.length){
      for(var i=0;i<cur.buys.length;i++){
        var b=cur.buys[i];
        var isBase=i===0;
        h+='<div class="trade-card">';
        h+='<div class="tc-header"><span class="tc-level '+(isBase?'tc-base':'tc-mart')+'">'+(isBase?'BASE BET':'MARTINGALE #'+b.level)+'</span><span class="tc-side '+b.side.toLowerCase()+'">'+b.side.toUpperCase()+'</span></div>';
        h+='<div class="tc-details">';
        h+='<div class="tc-detail"><div class="lbl">Shares</div><div class="val">'+b.shares.toFixed(2)+'sh</div></div>';
        h+='<div class="tc-detail"><div class="lbl">Price</div><div class="val">@'+b.price.toFixed(3)+'</div></div>';
        h+='<div class="tc-detail"><div class="lbl">Bet</div><div class="val">$'+fmt2(b.dollars)+'</div></div>';
        h+='<div class="tc-detail"><div class="lbl">Cost</div><div class="val">$'+fmt2(b.cost)+'</div></div>';
        h+='</div></div>';
      }
    }
    // Pending sells
    if(cur.sells&&cur.sells.length){
      h+='<div style="margin-top:6px;font-size:9px;color:#ff8800">';
      for(var j=0;j<cur.sells.length;j++){
        var s=cur.sells[j];
        h+='Stop: sold '+s.shares.toFixed(2)+'sh @'+s.price.toFixed(3)+' rec=$'+fmt2(s.proceeds)+'<br>';
      }
      h+='</div>';
    }
  }
  // Pending trades (from other windows)
  var pending=st.pending||[];
  if(pending.length){
    h+='<div class="section-hdr">Pending Resolution ('+pending.length+')</div>';
    for(var p=0;p<Math.min(pending.length,3);p++){
      var pt=pending[p];
      h+='<div style="font-size:9px;color:#aaa;padding:2px 0">'+(pt.leg?pt.leg.slug:'')+' — '+pt.phase+' — cost=$'+fmt2(pt.totalCost)+'</div>';
    }
  }
  // History
  var hist=st.history||[];
  if(hist.length){
    h+='<div class="section-hdr">Recent Windows</div>';
    h+='<div class="history-list">';
    for(var k=0;k<Math.min(hist.length,30);k++){
      var hw=hist[k];
      var resClass=hw.win===true?'h-win':hw.win===false?'h-loss':hw.skipped?'h-skip':'';
      var resText=hw.skipped?'SKIP':hw.win===true?'WIN':'LOSS';
      var legs=hw.legs||[];
      h+='<div class="h-item">';
      h+='<span style="color:#666;min-width:40px">'+hw.slug.replace('btc-updown-'+label+'-','')+'</span>';
      h+='<span style="color:#aaa;min-width:30px">'+legs.length+'leg</span>';
      h+='<span style="color:#888;font-size:8px">SL:'+hw.stopLossCount+'</span>';
      h+='<span class="h-result '+resClass+'">'+resText+'</span>';
      h+='<span class="h-pnl '+pC(hw.pnl)+'">'+sgn(hw.pnl)+'</span>';
      h+='</div>';
    }
    h+='</div>';
  }
  // Trades list
  var trades=st.trades||[];
  if(trades.length){
    h+='<div class="section-hdr">Trade Log</div>';
    h+='<div class="history-list">';
    for(var t=0;t<Math.min(trades.length,30);t++){
      var tr=trades[t];
      h+='<div class="h-item">';
      h+='<span style="color:#888">'+tr.time+'</span>';
      h+='<span style="color:#aaa">'+tr.type+'</span>';
      h+='</div>';
    }
    h+='</div>';
  }
  if(!cur||!cur.leg||!cur.leg.discovered)h+='<div style="color:#666;padding:8px;text-align:center">Waiting for window discovery...</div>';
  return h;
}

function drawChart(){
  var canvas=$('eq-chart');if(!canvas)return;
  var ctx=canvas.getContext('2d');
  var dpr=window.devicePixelRatio||1,W=canvas.clientWidth||800,H=canvas.clientHeight||120;
  canvas.width=W*dpr;canvas.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);
  var curves=[];
  if(latest.m5&&latest.m5.equityCurve&&latest.m5.equityCurve.length>=2)curves.push({data:latest.m5.equityCurve,cap:latest.m5.startingCapital,color:'#0099cc',label:'5m'});
  if(latest.m15&&latest.m15.equityCurve&&latest.m15.equityCurve.length>=2)curves.push({data:latest.m15.equityCurve,cap:latest.m15.startingCapital,color:'#aa88ff',label:'15m'});
  if(!curves.length){ctx.fillStyle='#888';ctx.font='10px monospace';ctx.fillText('Collecting data...',14,20);return}
  var min=Infinity,max=-Infinity;
  curves.forEach(function(c){c.data.forEach(function(p){if(p.equity<min)min=p.equity;if(p.equity>max)max=p.equity});min=Math.min(min,c.cap);max=Math.max(max,c.cap)});
  var pad=10,xA=function(i,l){return pad+(i/(l-1))*(W-pad*2)},yA=function(v){return H-pad-((v-min)/((max-min)||1))*(H-pad*2)};
  ctx.strokeStyle='#333';ctx.lineWidth=1;for(var g=0;g<=4;g++){var gy=pad+(g/4)*(H-pad*2);ctx.beginPath();ctx.moveTo(pad,gy);ctx.lineTo(W-pad,gy);ctx.stroke()}
  curves.forEach(function(c){
    var d=c.data,vals=d.map(function(p){return p.equity});
    ctx.globalAlpha=.5;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(pad,yA(c.cap));ctx.lineTo(W-pad,yA(c.cap));ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.beginPath();ctx.moveTo(xA(0,d.length),yA(vals[0]));for(var i=1;i<d.length;i++)ctx.lineTo(xA(i,d.length),yA(vals[i]));
    ctx.strokeStyle=c.color;ctx.lineWidth=2;ctx.stroke();
    ctx.lineTo(xA(d.length-1,d.length),H-pad);ctx.lineTo(xA(0,d.length),H-pad);ctx.closePath();ctx.fillStyle=c.color+'11';ctx.fill();
    ctx.fillStyle=c.color;ctx.beginPath();ctx.arc(xA(d.length-1,d.length),yA(vals[vals.length-1]),3.5,0,Math.PI*2);ctx.fill();
  });
  ctx.font='9px monospace';ctx.fillStyle='#888';
  if(max!==Infinity)ctx.fillText('$'+max.toFixed(0),4,14);
  if(min!==-Infinity)ctx.fillText('$'+min.toFixed(0),4,H-4);
}

function render(){
  var s5=latest.m5,s15=latest.m15;
  // Stats
  var s5s=latest.m5s,s15s=latest.m15s;
  var totalPnl=(s5?s5.realizedPnl:0)+(s15?s15.realizedPnl:0)+(s5s?s5s.realizedPnl:0)+(s15s?s15s.realizedPnl:0);
  var totalBankroll=(s5?s5.bankroll:0)+(s15?s15.bankroll:0)+(s5s?s5s.bankroll:0)+(s15s?s15s.bankroll:0);
  var totalW=(s5?s5.wins:0)+(s15?s15.wins:0)+(s5s?s5s.wins:0)+(s15s?s15s.wins:0);
  var totalL=(s5?s5.losses:0)+(s15?s15.losses:0)+(s5s?s5s.losses:0)+(s15s?s15s.losses:0);
  var totalUnreal=(s5?s5.totalUnrealized:0)+(s15?s15.totalUnrealized:0)+(s5s?s5s.totalUnrealized:0)+(s15s?s15s.totalUnrealized:0);
  var totalEquity=(s5?s5.equity:0)+(s15?s15.equity:0)+(s5s?s5s.equity:0)+(s15s?s15s.equity:0);
  var wr=totalW+totalL>0?((totalW/(totalW+totalL))*100).toFixed(1)+'%':'--';
  $('stats-row').innerHTML=[
    '<div class="st"><div class="st-l">Equity</div><div class="st-v '+pC(totalEquity-((s5?s5.startingCapital:0)+(s15?s15.startingCapital:0)))+'">$'+fmt2(totalEquity)+'</div></div>',
    '<div class="st"><div class="st-l">Realized</div><div class="st-v '+pC(totalPnl)+'">'+sgn(totalPnl)+'</div></div>',
    '<div class="st"><div class="st-l">Unrealized</div><div class="st-v '+pC(totalUnreal)+'">'+sgn(totalUnreal)+'</div></div>',
    '<div class="st"><div class="st-l">W/L ('+wr+')</div><div class="st-v"><span class="pos">'+totalW+'W</span>/<span class="neg">'+totalL+'L</span></div></div>',
  ].join('');
  $('m5-body').innerHTML=panelHtml(s5,'5m');
  $('m5-badge').textContent=(s5?s5.wins+'W/'+s5.losses+'L':'--')+' | '+sgn(s5?s5.realizedPnl:0);
  $('m15-body').innerHTML=panelHtml(s15,'15m');
  $('m15-badge').textContent=(s15?s15.wins+'W/'+s15.losses+'L':'--')+' | '+sgn(s15?s15.realizedPnl:0);
  $('m5s-body').innerHTML=panelHtml(s5s,'5m-S');
  $('m5s-badge').textContent=(s5s?s5s.wins+'W/'+s5s.losses+'L':'--')+' | '+sgn(s5s?s5s.realizedPnl:0);
  $('m15s-body').innerHTML=panelHtml(s15s,'15m-S');
  $('m15s-badge').textContent=(s15s?s15s.wins+'W/'+s15s.losses+'L':'--')+' | '+sgn(s15s?s15s.realizedPnl:0);
  var live=(s5&&!s5.dryRun)||(s15&&!s15.dryRun)||(s5s&&!s5s.dryRun)||(s15s&&!s15s.dryRun);
  $('mode-badge').className='badge '+(live?'badge-live':'badge-dem');
  $('mode-badge').textContent=live?'LIVE':'DEMO';
  drawChart();
}

function renderLogs(){
  var el=$('log-box');if(!el)return;
  var wasAtBottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;
  el.innerHTML=allLogs.slice(-200).map(function(l){
    var c='';
    if(l.indexOf('WIN')>=0)c=' style="color:#00ff88"';
    else if(l.indexOf('LOSS')>=0||l.indexOf('STOP')>=0)c=' style="color:#ff4444"';
    else if(l.indexOf('P&L')>=0||l.indexOf('$')>=0)c=' style="color:#ffcc00"';
    else if(l.indexOf('🔌')>=0||l.indexOf('WebSocket')>=0)c=' style="color:#00ccff"';
    else if(l.indexOf('🎯')>=0||l.indexOf('ENTRY')>=0)c=' style="color:#00ff88"';
    return'<div'+c+'>'+l.replace(/</g,'&lt;')+'</div>';
  }).join('');
  if(wasAtBottom)el.scrollTop=el.scrollHeight;
}

socket.on('hedgeState:BTC-5m',function(s){latest.m5=s;render()});
socket.on('hedgeState:BTC-15m',function(s){latest.m15=s;render()});
socket.on('hedgeState:BTC-5m-Skip',function(s){latest.m5s=s;render()});
socket.on('hedgeState:BTC-15m-Skip',function(s){latest.m15s=s;render()});
socket.on('log',function(line){allLogs.push(line);if(allLogs.length>500)allLogs.shift();renderLogs()});

// Also load logs from state on initial render
function loadLogsFromState(){
  if(latest.m5&&latest.m5.logs){latest.m5.logs.forEach(function(l){if(allLogs.indexOf(l)<0)allLogs.push(l)})}
  if(latest.m15&&latest.m15.logs){latest.m15.logs.forEach(function(l){if(allLogs.indexOf(l)<0)allLogs.push(l)})}
  if(latest.m5s&&latest.m5s.logs){latest.m5s.logs.forEach(function(l){if(allLogs.indexOf(l)<0)allLogs.push(l)})}
  if(latest.m15s&&latest.m15s.logs){latest.m15s.logs.forEach(function(l){if(allLogs.indexOf(l)<0)allLogs.push(l)})}
  renderLogs();
}
socket.on('connect',function(){loadLogsFromState()});

setInterval(render,1000);
setInterval(async function(){
  try{var res=await fetch('/api/hedge/status'),st=await res.json();
    if(st.m5)latest.m5=st.m5;if(st.m5)latest.m5=st.m5;if(st.m5s)latest.m5s=st.m5s;if(st.m15)latest.m15=st.m15;if(st.m15s)latest.m15s=st.m15s;render();loadLogsFromState();
  }catch(e){}
},10000);
render();
</script></body></html>`;

app.get('/', (_, res) => { res.type('html').send(DASH); });

const emit = (event, data) => io.emit(event, data);
const slog = (line) => { console.log(line); io.emit('log', line); };

const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('❌ PRIVATE_KEY env var missing'); process.exit(1); }

console.log('⛏ BTC Martingale Bot — 5m + 15m independent windows');
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Dashboard: http://0.0.0.0:${PORT}`);
  (async () => {
    const trader = new PolymarketTrader(PK);
    await trader.authenticate();
    const mkEngine = (label, type, cap, winSec, waitSec, statsPath, skipFirst = false) => createEngine({
      label, windowType: type, startingCapital: cap, entryPrice: ENTRY_PRICE,
      stopLossPrice: STOP_LOSS_PRICE, entryDollars: ENTRY_DOLLARS,
      martingaleMultiplier: MARTINGALE_MULTIPLIER, maxMartingaleLevels: MAX_MARTINGALE_LEVELS,
      waitSeconds5: waitSec, windowSeconds5: winSec,
      feeTheta: FEE_THETA, rebatePct: REBATE_PCT,
      statsStatePath: statsPath, trader, dryRun: DRY_RUN, emit, slog,
      skipFirst,
    });
    // 5m engines share capital, 15m engines share capital
    engine5 = mkEngine('BTC-5m', '5m', CAPITAL_5, 300, WAIT_SECONDS_5, process.env.STATS_STATE_PATH || path.join(__dirname, 'stats-5m.json'), false);
    engine5s = mkEngine('BTC-5m-Skip', '5m', CAPITAL_5, 300, WAIT_SECONDS_5, path.join(__dirname, 'stats-5m-skip.json'), true);
    engine15 = mkEngine('BTC-15m', '15m', CAPITAL_15, 900, WAIT_SECONDS_15, process.env.STATS_STATE_PATH_15 || path.join(__dirname, 'stats-15m.json'), false);
    engine15s = mkEngine('BTC-15m-Skip', '15m', CAPITAL_15, 900, WAIT_SECONDS_15, path.join(__dirname, 'stats-15m-skip.json'), true);
    await engine5.start();
    await engine5s.start();
    await engine15.start();
    await engine15s.start();
  })().catch(e => {
    console.error('❌ Bot init failed:', e.message);
    process.exit(1);
  });
});
