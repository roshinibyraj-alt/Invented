'use strict';

function toCandle(row) {
  if (Array.isArray(row)) return { t:+row[0], o:+row[1], h:+row[2], l:+row[3], c:+row[4], v:+row[5] };
  return { t:+row.t, o:+row.o, h:+row.h, l:+row.l, c:+row.c, v:+(row.v||0) };
}

function aggregate(candles, intervalMs) {
  const groups = new Map();
  for (const x of candles.map(toCandle).sort((a,b)=>a.t-b.t)) {
    const t = Math.floor(x.t / intervalMs) * intervalMs;
    const c = groups.get(t);
    if (!c) groups.set(t, { t, o:x.o, h:x.h, l:x.l, c:x.c, v:x.v });
    else { c.h=Math.max(c.h,x.h); c.l=Math.min(c.l,x.l); c.c=x.c; c.v+=x.v; }
  }
  return [...groups.values()];
}

function detectMoveLadder({minuteCandles,windowStart,windowMs=900000,levelsPct=[25,50],sharesByLevel={25:100,50:100}}) {
  const minutes=minuteCandles.map(toCandle).sort((a,b)=>a.t-b.t);
  const bars=aggregate(minutes,windowMs);
  const history=bars.filter(x=>x.t<windowStart);
  const current=bars.find(x=>x.t===windowStart);
  if(!history.length||!current)return {ready:false,reason:`Waiting for previous and current ${windowMs/60000}-minute candles`};
  const previous=history[history.length-1];
  const previousBody=Math.abs(previous.c-previous.o);
  const previousColor=previous.c<previous.o?'red':previous.c>previous.o?'green':'doji';
  const signedMove=current.c-previous.c;
  const expectedMove=previousColor==='red'?'up':previousColor==='green'?'down':null;
  const side=expectedMove==='up'?'DOWN':expectedMove==='down'?'UP':null;
  const observedMove=expectedMove==='up'?Math.max(0,signedMove)
    :expectedMove==='down'?Math.max(0,-signedMove):0;
  const rungs=levelsPct.map(levelPct=>({
    levelPct,shares:Number(sharesByLevel[levelPct]??100),side,expectedMove,previousBody,
    requiredMove:previousBody*levelPct/100,
    observedMove,crossed:Boolean(side)&&observedMove>=previousBody*levelPct/100
  }));
  return {ready:true,windowStart,previousClose:previous.c,previousBody,previousColor,
    expectedMove,side,signedMove,observedMove,previous,current,rungs,
    reason:previousColor==='doji'?'Previous candle is a doji; no trigger side selected':null};
}

module.exports={toCandle,aggregate,detectMoveLadder};
