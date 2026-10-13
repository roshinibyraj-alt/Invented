'use strict';

const cfg=require('./config');

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

function detectTimedStrategy({minuteCandles,windowStart,windowMs=900000,now=Date.now()}) {
  const minutes=minuteCandles.map(toCandle).sort((a,b)=>a.t-b.t);
  const bars=aggregate(minutes,windowMs);
  const history=bars.filter(x=>x.t<windowStart);
  const current=bars.find(x=>x.t===windowStart);
  if(!history.length||!current)return {ready:false,reason:`Waiting for previous and current ${windowMs/60000}-minute candles`};
  const previous=history[history.length-1];
  const previousBody=Math.abs(previous.c-previous.o);
  const previousColor=previous.c<previous.o?'red':previous.c>previous.o?'green':'doji';
  const signedMove=current.c-previous.c;
  const side=previousColor==='green'?'UP':previousColor==='red'?'DOWN':null;
  const elapsedMs=now-windowStart;
  const entries=cfg.ENTRY_RUNGS.map(({movePct,shares})=>{
    const move=previousBody*movePct/100;
    const thresholdPrice=previousColor==='green'?previous.c-move
      :previousColor==='red'?previous.c+move:null;
    const crossed=Boolean(side&&elapsedMs>=0&&elapsedMs<windowMs&&
      (previousColor==='green'?current.l<=thresholdPrice:current.h>=thresholdPrice));
    return {key:`move-${movePct}`,label:`${movePct}% adverse move · ${shares} shares`,
      movePct,shares,side,thresholdPrice,windowEnd:windowStart+windowMs,crossed,
      observedPrice:current.c};
  });
  return {ready:true,windowStart,previousClose:previous.c,previousBody,previousColor,
    side,signedMove,elapsedMs,entryMode:'ADVERSE_MOVE_LADDER',previous,current,entries,
    reason:previousColor==='doji'?'Previous candle is a doji; no entry side selected':null};
}

module.exports={toCandle,aggregate,detectTimedStrategy};
