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

function rsi(closes, period=14) {
  if (closes.length < period+1) return null;
  let gain=0, loss=0;
  for (let i=closes.length-period;i<closes.length;i++) {
    const d=closes[i]-closes[i-1]; if(d>0)gain+=d;else loss-=d;
  }
  if (loss===0) return gain===0?50:100;
  return 100-100/(1+gain/loss);
}

function atr(candles, period=14) {
  if (candles.length < period+1) return null;
  const ranges=[];
  for(let i=candles.length-period;i<candles.length;i++){
    const x=candles[i],p=candles[i-1];
    ranges.push(Math.max(x.h-x.l,Math.abs(x.h-p.c),Math.abs(x.l-p.c)));
  }
  return ranges.reduce((a,b)=>a+b,0)/ranges.length;
}

function quantile(values,q) {
  if(!values.length)return null;
  const s=[...values].sort((a,b)=>a-b);
  return s[Math.min(s.length-1,Math.floor((s.length-1)*q))];
}

function hourSlot(windowStart) { return Math.floor((new Date(windowStart).getUTCMinutes()%60)/15); }
function rsiBand(value) { return value<40?'low':value>60?'high':'mid'; }

function detectWick({minuteCandles, now=Date.now(), windowStart}) {
  const minutes=minuteCandles.map(toCandle).sort((a,b)=>a.t-b.t);
  const bars15=aggregate(minutes,900000);
  const history=bars15.filter(x=>x.t<windowStart);
  const current=bars15.find(x=>x.t===windowStart);
  if(history.length<30||!current)return {ready:false,reason:'Need at least 30 prior 15-minute candles'};
  const previous=history[history.length-1];
  const atrNow=atr(history.slice(-15));
  const rsiNow=rsi(history.map(x=>x.c));
  if(!atrNow||rsiNow==null)return {ready:false,reason:'Warming up volatility and RSI'};
  const slot=hourSlot(windowStart), band=rsiBand(rsiNow);
  const refs=[];
  for(let i=15;i<history.length;i++){
    const sample=history.slice(0,i+1), candle=history[i], av=atr(sample.slice(-15));
    if(!av)continue;
    const sampleRsi=rsi(sample.map(x=>x.c));
    const q=hourSlot(candle.t);
    refs.push({slot:q,band:rsiBand(sampleRsi??50),
      upper:(candle.h-Math.max(candle.o,candle.c))/av,
      lower:(Math.min(candle.o,candle.c)-candle.l)/av});
  }
  const similar=refs.filter(x=>x.slot===slot&&x.band===band);
  const slotRefs=refs.filter(x=>x.slot===slot);
  const baseline=similar.length>=12?similar:slotRefs.length>=12?slotRefs:refs;
  if(baseline.length<12)return {ready:false,reason:'Not enough comparable candles'};
  const tailThreshold={upper:quantile(baseline.map(x=>x.upper),.75),
    lower:quantile(baseline.map(x=>x.lower),.75)};
  const recentMinutes=minutes.filter(x=>x.t>=windowStart&&x.t<windowStart+900000);
  const last=recentMinutes.at(-1), prevMinute=recentMinutes.at(-2);
  if(!last||!prevMinute)return {ready:false,reason:'Waiting for minute confirmation'};
  const hour=aggregate(minutes,3600000).find(x=>x.t<=now&&x.t+3600000>now);
  const hourBias=hour?(hour.c>hour.o?'up':hour.c<hour.o?'down':'flat'):'unknown';
  const range=Math.max(current.h-current.l,1e-9);
  const candidates=[];
  for(const kind of ['lower','upper']){
    const extreme=kind==='lower'?current.l:current.h;
    const wick=kind==='lower'?Math.min(current.o,current.c)-current.l:current.h-Math.max(current.o,current.c);
    const normalized=wick/atrNow, threshold=tailThreshold[kind];
    const side=kind==='lower'?'UP':'DOWN';
    const boundaryOk=kind==='lower'?extreme>=previous.c:extreme<=previous.c;
    const retrace=kind==='lower'?(current.c-current.l)/range:(current.h-current.c)/range;
    const momentum=kind==='lower'?last.c>=prevMinute.c:last.c<=prevMinute.c;
    const confirmed=wick>0&&normalized>=threshold&&boundaryOk&&retrace>=0.5&&momentum;
    const rsiSupport=kind==='lower'?rsiNow<=55:rsiNow>=45;
    const hourSupport=hourBias==='flat'||hourBias==='unknown'||hourBias===side.toLowerCase();
    const score=Math.min(1,normalized/Math.max(threshold,0.01))*.55+(rsiSupport?.25:0)+(hourSupport?.20:0);
    const extremeBar=recentMinutes.find(x=>kind==='lower'?x.l===current.l:x.h===current.h);
    candidates.push({kind,side,normalized,threshold,confirmed,boundaryOk,retrace,rsiSupport,
      hourSupport,score,extremeAt:extremeBar?.t??windowStart,entryType:now-(extremeBar?.t??windowStart)>60000?'CHASE':'DIRECT'});
  }
  const signal=candidates.filter(x=>x.confirmed).sort((a,b)=>b.score-a.score)[0]||null;
  return {ready:true,windowStart,slot,previousClose:previous.c,atr:atrNow,rsi:rsiNow,
    hourBias,similarCount:similar.length,baselineCount:baseline.length,threshold:tailThreshold,
    current:{...current},candidates,signal};
}

module.exports={toCandle,aggregate,rsi,atr,quantile,hourSlot,detectWick};
