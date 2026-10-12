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
  const elapsedMs=now-windowStart,firstMinute=minutes.find(x=>x.t===windowStart);
  const secondMinute=minutes.find(x=>x.t===windowStart+60000);
  const firstActive=elapsedMs>=0&&elapsedMs<60000;
  const secondActive=elapsedMs>=60000&&elapsedMs<120000;
  const firstThreshold=previousColor==='green'?previous.c-previousBody*.25
    :previousColor==='red'?previous.c+previousBody*.25:null;
  const firstTouched=Boolean(side&&firstActive&&firstMinute&&
    (previousColor==='green'?firstMinute.l<=firstThreshold:firstMinute.h>=firstThreshold));
  const secondTouched=Boolean(side&&secondActive&&secondMinute&&
    (previousColor==='green'?secondMinute.h>=previous.c:secondMinute.l<=previous.c));
  const entries=[
    {key:'first-minute',label:'Minute 1 · 25% adverse move',shares:100,side,
      thresholdPrice:firstThreshold,windowEnd:windowStart+60000,crossed:firstTouched,
      observedPrice:firstMinute?.c??null},
    {key:'second-minute',label:'Minute 2 · return to 0%',shares:200,side,
      thresholdPrice:previous.c,windowEnd:windowStart+120000,crossed:secondTouched,
      observedPrice:secondMinute?.c??null}
  ];
  const exitThreshold=previousColor==='green'?previous.c-previousBody*.25
    :previousColor==='red'?previous.c+previousBody*.25:null;
  const exitAfterMs=180000;
  const exitTriggered=Boolean(side&&elapsedMs>=exitAfterMs&&
    (previousColor==='green'?current.c<=exitThreshold:current.c>=exitThreshold));
  const exit={eligible:elapsedMs>=exitAfterMs,triggered:exitTriggered,side,
    thresholdPrice:exitThreshold,currentPrice:current.c,afterSeconds:exitAfterMs/1000};
  return {ready:true,windowStart,previousClose:previous.c,previousBody,previousColor,
    side,signedMove,elapsedMs,entryMode:'TIMED',previous,current,entries,exit,
    reason:previousColor==='doji'?'Previous candle is a doji; no entry side selected':null};
}

module.exports={toCandle,aggregate,detectTimedStrategy};
