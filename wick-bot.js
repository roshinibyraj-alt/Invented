'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');
const {detectTimedStrategy,aggregate}=require('./wick-core');

function levels(xs){return (xs||[]).map(x=>({price:Number(x.price),size:Number(x.size)}))
  .filter(x=>Number.isFinite(x.price)&&x.size>0).sort((a,b)=>a.price-b.price)}
function quoteFromBook(book,updatedAt){
  const bids=levels(book.bids),asks=levels(book.asks);
  const bid=bids.sort((a,b)=>b.price-a.price)[0]||null;
  const ask=asks[0]||null;
  return {status:bid||ask?'LIVE':'MISSING',bestBid:bid?.price??null,bidSize:bid?.size??0,
    bestAsk:ask?.price??null,askSize:ask?.size??0,updatedAt,stale:false,error:null};
}
function payout(m,side){
  const outcomes=Array.isArray(m.outcomes)?m.outcomes:parse(m.outcomes);
  const prices=Array.isArray(m.outcomePrices)?m.outcomePrices:parse(m.outcomePrices);
  const idx=outcomes.findIndex(x=>String(typeof x==='string'?x:x.name||x.label).toUpperCase()===side);
  const status=String(m.status||'').toUpperCase();
  if(!(m.closed===true||m.resolved===true||['CLOSED','RESOLVED','SETTLED'].includes(status))||idx<0)return null;
  const p=Number(prices[idx]??(typeof outcomes[idx]==='object'?outcomes[idx].payout:NaN));
  return p>=.99?1:p<=.01?0:null;
}
function parse(x){if(typeof x==='string'){try{return JSON.parse(x)}catch(_){}}return []}
function sweep(asks,qty,maxPrice,minPrice=cfg.MIN_ENTRY_ASK){
  let left=qty,cost=0;
  for(const x of levels(asks)){
    if(x.price<minPrice)continue;
    if(x.price>maxPrice)break;
    const take=Math.min(left,x.size);cost+=take*x.price;left-=take;
    if(left<1e-8)break;
  }
  return left>1e-8?null:{shares:qty,cost,avg:cost/qty};
}
function feeFor(m,avg,qty){
  if(m.feesEnabled===false)return 0;
  const rate=Number(m.feeSchedule?.rate??m.takerFeeRate??cfg.FEE_RATE);
  const exp=Number(m.feeSchedule?.exponent??1);
  return rate*Math.pow(avg*(1-avg),exp)*qty;
}

class WickBot{
  constructor({timeframe='15m',windowMs=cfg.WINDOW_MS,capital=cfg.DEMO_CAPITAL_15M}={}){
    this.timeframe=timeframe;this.windowMs=windowMs;this.capital=capital;this.cash=capital;
    this.positions=[];this.events=[];this.status='starting';
    this.error=null;this.market=null;this.candles=[];this.lastMarketAt=0;
    this.lastCandlesAt=0;this.lastScanAt=null;this.rungState={};this.running=false;
    this.quoteWindowStart=null;this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
  }
  log(event,data={}){const e={ts:Date.now(),timeframe:this.timeframe,event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/this.windowMs)*this.windowMs;
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
      }
      if(!this.market||this.market.start!==start||now-this.lastMarketAt>cfg.MARKET_REFRESH_MS){
        this.market=await md.getBtcMarket(start,this.windowMs);this.lastMarketAt=now;
        if(!this.market){
          this.status='waiting_for_market';this.lastScanAt=now;
          if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{status:this.status,windowStart:start})}
          return;
        }
      }
      if(!this.candles.length||now-this.lastCandlesAt>cfg.CANDLE_REFRESH_MS){
        this.candles=await md.getMinuteCandles();this.lastCandlesAt=now;
      }
      await this.refreshLiveQuotes(now);
      const analysis=detectTimedStrategy({minuteCandles:this.candles,windowStart:start,windowMs:this.windowMs,now});
      this.analysis=analysis;this.lastScanAt=now;this.error=null;
      for(const p of this.positions){
        if((p.status==='OPEN'||p.status==='PENDING_OFFICIAL_RESULT')
          &&now>=p.windowStart+this.windowMs
          &&now-(p.lastSettlementAttempt||0)>=15000) await this.trySettle(p);
      }
      if(analysis.ready){
        const state=this.rungState[start]||(this.rungState[start]={triggered:{},filled:{},blocks:{}});
        for(const entry of analysis.entries){
          const key=entry.key,trigger=state.triggered[key];
          if(entry.crossed&&!trigger){
            state.triggered[key]={...entry,triggeredAt:now};
            this.log('TIMED_ENTRY_TRIGGER',{side:entry.side,entry:key,label:entry.label,
              shares:entry.shares,thresholdPrice:entry.thresholdPrice,observedPrice:entry.observedPrice});
          }
          const saved=state.triggered[key];
          if(saved&&!state.filled[key]){
            if(now<saved.windowEnd)await this.tryEnter(start,saved,key);
            else if(!state.expired?.[key]){
              state.expired=state.expired||{};state.expired[key]=true;
              this.log('TIMED_ENTRY_EXPIRED',{entry:key,side:saved.side,shares:saved.shares,note:'Its minute window ended before a paper fill'});
            }
          }
          entry.triggered=Boolean(saved);entry.filled=Boolean(state.filled[key]);
          entry.expired=Boolean(state.expired?.[key]);entry.block=state.blocks[key]||null;
        }
      }
      const hasOpen=this.positions.some(p=>p.windowStart===start&&p.status==='OPEN');
      this.status=hasOpen?'position_open':'scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
  }
  async refreshLiveQuotes(now){
    if(!this.market)return;
    const sides=['UP','DOWN'];
    const results=await Promise.allSettled(sides.map(side=>md.getBook(this.market.tokens[side])));
    sides.forEach((side,i)=>{
      const result=results[i];
      if(result.status==='fulfilled')this.liveQuotes[side]=quoteFromBook(result.value,now);
      else{
        const previous=this.liveQuotes[side]||{};
        const stale=previous.updatedAt?now-previous.updatedAt>10000:true;
        this.liveQuotes[side]={...previous,status:previous.updatedAt?(stale?'STALE':'LIVE'):'ERROR',stale,
          attemptedAt:now,error:result.reason?.message||'Order book unavailable'};
      }
    });
    const open=this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_OFFICIAL_RESULT');
    for(const p of open){
      if(p.windowStart===this.market.start){
        const q=this.liveQuotes[p.side];
        p.markBid=q?.bestBid??null;p.markUpdatedAt=q?.updatedAt||now;p.markStatus=q?.bestBid!=null?'LIVE':'MISSING';
      }
    }
    const due=open.filter(p=>p.windowStart!==this.market.start&&p.tokenId&&now-(p.lastMarkAttempt||0)>=5000);
    await Promise.all(due.map(async p=>{
      p.lastMarkAttempt=now;
      try{const q=quoteFromBook(await md.getBook(p.tokenId),now);p.markBid=q.bestBid;p.markUpdatedAt=now;p.markStatus=q.bestBid!=null?'LIVE':'MISSING'}
      catch(_){p.markStatus=p.markBid!=null?'STALE':'MISSING'}
    }));
  }
  async tryEnter(start,trigger,key){
    if(Date.now()>=trigger.windowEnd)return;
    const state=this.rungState[start];
    const token=this.market.tokens[trigger.side],book=await md.getBook(token);
    const fill=sweep(book.asks,trigger.shares,cfg.MAX_ENTRY_ASK,cfg.MIN_ENTRY_ASK);
    if(!fill){state.blocks[key]=`Need ${trigger.shares} shares at asks from $${cfg.MIN_ENTRY_ASK.toFixed(2)} to $${cfg.MAX_ENTRY_ASK.toFixed(2)}`;return}
    const fee=feeFor(this.market.raw,fill.avg,fill.shares),total=fill.cost+fee;
    if(total>this.cash){state.blocks[key]='Insufficient demo cash';return}
    const p={id:`${this.timeframe}-${start}-${trigger.side}-${key}`,timeframe:this.timeframe,
      windowMs:this.windowMs,windowStart:start,marketId:this.market.id,slug:this.market.slug,
      title:this.market.title,side:trigger.side,tokenId:token,entryKey:key,entryLabel:trigger.label,
      triggerPct:saved.movePct,entryType:'CANDLE_MOVE_RUNG',shares:fill.shares,initialShares:fill.shares,
      avgEntry:fill.avg,cost:fill.cost,fees:fee,totalCost:total,status:'OPEN',openedAt:Date.now(),
      thresholdPrice:trigger.thresholdPrice,observedPrice:trigger.observedPrice};
    this.cash-=total;this.positions.unshift(p);state.filled[key]=p.id;delete state.blocks[key];this.status='position_open';
    this.log('PAPER_TIMED_ENTRY',{timeframe:this.timeframe,id:p.id,side:p.side,entry:key,label:p.entryLabel,
      shares:p.shares,entryPrice:p.avgEntry,avgEntry:p.avgEntry,cost:p.totalCost});
  }
  async trySettle(p){
    if(Date.now()<p.windowStart+(p.windowMs||this.windowMs))return;
    p.lastSettlementAttempt=Date.now();
    try{
      const m=await md.getMarket(p.marketId),won=payout(m,p.side);
      if(won==null){p.status='PENDING_OFFICIAL_RESULT';this.status='awaiting_official_result';return}
      p.payout=won;p.proceeds=won*p.shares;p.realizedPnl=(p.realizedPnl||0)+p.proceeds-p.totalCost;
      p.status=won?'SETTLED_WIN':'SETTLED_LOSS';p.settledAt=Date.now();this.cash+=p.proceeds;
      this.log('PAPER_WICK_SETTLED',{id:p.id,status:p.status,pnl:p.realizedPnl});
    }catch(e){p.status='PENDING_OFFICIAL_RESULT';this.status='awaiting_official_result';}
  }
  snapshot(){
    const prior=this.market?aggregate(this.candles,this.windowMs)
      .filter(x=>x.t<this.market.start).slice(-3):[];
    const now=Date.now();
    const realizedPnl=this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0);
    let unrealizedPnl=0,unpricedOpenPositions=0,markedValue=0;
    for(const p of this.positions){
      if(p.status!=='OPEN'&&p.status!=='PENDING_OFFICIAL_RESULT'){
        p.markValue=0;p.unrealizedPnl=0;p.markStatus='CLOSED';continue;
      }
      const mark=p.markBid==null?null:p.markBid*p.shares;
      p.markValue=mark;
      p.unrealizedPnl=mark==null?null:mark-p.totalCost;
      p.markAgeMs=p.markUpdatedAt?Math.max(0,now-p.markUpdatedAt):null;
      p.markStatus=mark==null?'UNAVAILABLE':p.markAgeMs>15000?'STALE':'LIVE';
      if(mark==null)unpricedOpenPositions++;else{markedValue+=mark;unrealizedPnl+=p.unrealizedPnl}
    }
    return {now,mode:'DEMO ONLY',status:this.status,error:this.error,
        strategy:{timeframe:this.timeframe,market:`Polymarket BTC ${this.windowMs/60000}-minute UP/DOWN`,capital:this.capital,
          entries:cfg.ENTRY_RUNGS.map(rung=>({...rung,reference:'previous candle body from close',
            timing:'any time during the window'})),
          exit:'No sell orders; hold open shares to official market settlement',
          minEntryAsk:cfg.MIN_ENTRY_ASK,maxEntryAsk:cfg.MAX_ENTRY_ASK,
          execution:'PAPER ONLY'},
       account:{capital:this.capital,cash:this.cash,realizedPnl,unrealizedPnl,equity:this.cash+markedValue,
         markedValue,unpricedOpenPositions,
        openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_OFFICIAL_RESULT').length},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
       scanner:{timeframe:this.timeframe,lastScanAt:this.lastScanAt,candleSource:`Kraken XBT/USD 1m; minute 1/2 extrema and live move compared with previous completed ${this.windowMs/60000}m window`,
        marketResolution:'Polymarket official outcome',analysis:this.analysis||null,
           previousCandles:prior,rungState:this.rungState[this.market?.start]||null},
      positions:this.positions.slice(0,50),events:this.events};
  }
  start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{timeframe:this.timeframe,note:`Demo-only BTC ${this.windowMs/60000}m candle-move ladder; no live orders.`});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={sweep,feeFor,payout,quoteFromBook};
