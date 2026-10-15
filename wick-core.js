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

function candleShape(row) {
  const c=toCandle(row),range=Math.max(0,c.h-c.l),body=Math.abs(c.c-c.o);
  return {c,range,body,upper:c.h-Math.max(c.o,c.c),lower:Math.min(c.o,c.c)-c.l,
    direction:c.c>c.o?'bullish':c.c<c.o?'bearish':'neutral'};
}

function detectCandlePatternSignal(history) {
  const bars=history.map(candleShape);
  const n=bars.length,last=bars[n-1];
  if(!last)return {side:null,pattern:null,strength:0,patterns:[],reason:'No completed candles available for pattern analysis'};
  const prior=bars[n-2],twoBack=bars[n-3];
  const trend=(end,count)=>{
    if(end-count<0)return null;
    const first=bars[end-count].c.c,finish=bars[end-1].c.c;
    return finish>first?'up':finish<first?'down':null;
  };
  const recentTrend=trend(n-1,3),patterns=[];
  const add=(name,side,strength)=>patterns.push({name,side,strength});
  const {c,range,body,upper,lower,direction}=last;
  if(range>0){
    const doji=body/range<=.10;
    if(doji){
      const nearby=bars.slice(Math.max(0,n-6),n-1).map(x=>x.range).filter(x=>x>0);
      const averageRange=nearby.length?nearby.reduce((sum,x)=>sum+x,0)/nearby.length:null;
      if(lower/range>=.65&&upper/range<=.10)add('Dragonfly Doji','UP',3);
      else if(upper/range>=.65&&lower/range<=.10)add('Gravestone Doji','DOWN',3);
      else if(upper/range>=.35&&lower/range>=.35&&averageRange!=null&&range>=averageRange*1.5)
        add('Long-Legged Doji',null,0);
      else add('Standard Doji',null,0);
    }else{
      const smallBody=body/range<=.35;
      if(smallBody&&lower>=2*body&&upper<=.25*body&&recentTrend==='down')
        add('Hammer','UP',2);
      if(smallBody&&upper>=2*body&&lower<=.25*body&&recentTrend==='down')
        add('Inverted Hammer','UP',2);
      if(smallBody&&upper>=2*body&&lower<=.25*body&&recentTrend==='up')
        add('Shooting Star','DOWN',2);
      if(smallBody&&lower>=2*body&&upper<=.25*body&&recentTrend==='up')
        add('Hanging Man','DOWN',2);
      if(upper/range<=.05&&lower/range<=.05)add(direction==='bullish'?'Green Marubozu':'Red Marubozu',direction==='bullish'?'UP':'DOWN',2);
      if(smallBody&&upper>=body&&lower>=body&&Math.abs(upper-lower)/range<=.2)
        add('Spinning Top',null,0);
    }
  }
  if(prior){
    const a=prior.c,b=c;
    if(prior.direction==='bearish'&&direction==='bullish'&&b.o<=a.c&&b.c>=a.o)
      add('Bullish Engulfing','UP',4);
    if(prior.direction==='bullish'&&direction==='bearish'&&b.o>=a.c&&b.c<=a.o)
      add('Bearish Engulfing','DOWN',4);
    const tolerance=Math.max(a.h-a.l,b.h-b.l)*.08;
    if(Math.abs(a.l-b.l)<=tolerance&&prior.direction!==direction&&prior.direction==='bearish'&&direction==='bullish')
      add('Tweezer Bottom','UP',3);
    if(Math.abs(a.h-b.h)<=tolerance&&prior.direction!==direction&&prior.direction==='bullish'&&direction==='bearish')
      add('Tweezer Top','DOWN',3);
    const inside=b.h<=a.h&&b.l>=a.l;
    if(inside&&prior.direction==='bearish'&&direction==='bullish')add('Bullish Harami','UP',2);
    if(inside&&prior.direction==='bullish'&&direction==='bearish')add('Bearish Harami','DOWN',2);
  }
  if(twoBack&&prior){
    const first=twoBack,lastTwo=prior;
    const firstBody=first.body,midpoint=(first.c.o+first.c.c)/2;
    if(first.direction==='bearish'&&firstBody>0&&lastTwo.body/Math.max(lastTwo.range,1e-12)<=.35
      &&direction==='bullish'&&c.c>midpoint)add('Morning Star','UP',5);
    if(first.direction==='bullish'&&firstBody>0&&lastTwo.body/Math.max(lastTwo.range,1e-12)<=.35
      &&direction==='bearish'&&c.c<midpoint)add('Evening Star','DOWN',5);
  }
  if(n>=3){
    const trio=bars.slice(-3);
    if(trio.every(x=>x.direction==='bullish'&&x.range>0&&x.body/x.range>=.55&&x.upper/x.range<=.25))
      add('Three White Soldiers','UP',5);
    if(trio.every(x=>x.direction==='bearish'&&x.range>0&&x.body/x.range>=.55&&x.lower/x.range<=.25))
      add('Three Black Crows','DOWN',5);
  }
  const directional=patterns.filter(x=>x.side);
  if(!directional.length){
    const neutral=patterns.sort((a,b)=>b.strength-a.strength)[0]||null;
    return {side:null,pattern:neutral?.name||null,strength:0,patterns,
      reason:neutral?`${neutral.name} has no directional bias`:'No qualifying candle pattern'};
  }
  const best=Math.max(...directional.map(x=>x.strength));
  const leaders=directional.filter(x=>x.strength===best);
  const sides=new Set(leaders.map(x=>x.side));
  if(sides.size>1)return {side:null,pattern:'Conflicting candle patterns',strength:best,patterns,
    reason:'Equally strong bullish and bearish patterns; no side selected'};
  const selected=leaders[0];
  return {side:selected.side,pattern:selected.name,strength:selected.strength,patterns,reason:null};
}

function detectTimedStrategy({minuteCandles,windowStart,windowMs=300000,now=Date.now(),entryShares=cfg.ENTRY_FLOOR_SHARES}) {
  const minutes=minuteCandles.map(toCandle).sort((a,b)=>a.t-b.t);
  const bars=aggregate(minutes,windowMs),history=bars.filter(x=>x.t<windowStart);
  const current=bars.find(x=>x.t===windowStart);
  if(!history.length||!current)return {ready:false,reason:`Waiting for previous and current ${windowMs/60000}-minute candles`};
  const previous=history[history.length-1],signal=detectCandlePatternSignal(history);
  const elapsedMs=now-windowStart;
  const entries=signal.side?[{
    key:'candle-pattern-entry',label:`${signal.pattern} · ${signal.side} · ${entryShares} shares`,
    shares:entryShares,side:signal.side,windowEnd:windowStart+windowMs,
    crossed:elapsedMs>=cfg.ENTRY_DELAY_MS&&elapsedMs<cfg.ENTRY_CUTOFF_MS,
    expired:elapsedMs>=cfg.ENTRY_CUTOFF_MS,observedPrice:current.c,
    pattern:signal.pattern,signalStrength:signal.strength,
  }]:[];
  return {ready:true,windowStart,elapsedMs,entryMode:'CANDLE_PATTERN_DELAYED_SINGLE_ENTRY',
    side:signal.side,signalPattern:signal.pattern,signalStrength:signal.strength,
    signalPatterns:signal.patterns,signalReason:signal.reason,previous,current,
    previousClose:previous.c,previousBody:Math.abs(previous.c-previous.o),
    previousColor:previous.c<previous.o?'red':previous.c>previous.o?'green':'doji',
    signedMove:current.c-previous.c,entries,reason:signal.reason};
}

module.exports={toCandle,aggregate,detectCandlePatternSignal,detectTimedStrategy};
