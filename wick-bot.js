'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');
const {detectMoveLadder,aggregate}=require('./wick-core');

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
  constructor(){
    this.cash=cfg.DEMO_CAPITAL;this.positions=[];this.events=[];this.status='starting';
    this.error=null;this.market=null;this.candles=[];this.lastMarketAt=0;
    this.lastCandlesAt=0;this.lastScanAt=null;this.rungState={};this.running=false;
    this.quoteWindowStart=null;this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
  }
  log(event,data={}){const e={ts:Date.now(),event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/cfg.WINDOW_MS)*cfg.WINDOW_MS;
      if(this.quoteWindowStart!==start){
        this.quoteWindowStart=start;
        this.liveQuotes={UP:{status:'MISSING'},DOWN:{status:'MISSING'}};
      }
      if(!this.market||this.market.start!==start||now-this.lastMarketAt>cfg.MARKET_REFRESH_MS){
        this.market=await md.getBtc15Market(start);this.lastMarketAt=now;
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
      const analysis=detectMoveLadder({minuteCandles:this.candles,windowStart:start,
        levelsPct:cfg.TRIGGER_LEVELS_PCT,sharesPerTrigger:cfg.SHARES_PER_TRIGGER});
      this.analysis=analysis;this.lastScanAt=now;this.error=null;
      for(const p of this.positions){
        if((p.status==='OPEN'||p.status==='PENDING_OFFICIAL_RESULT')
          &&now>=p.windowStart+cfg.WINDOW_MS
          &&now-(p.lastSettlementAttempt||0)>=15000) await this.trySettle(p);
      }
      if(analysis.ready){
        const state=this.rungState[start]||(this.rungState[start]={triggered:{},filled:{},blocks:{}});
        for(const rung of analysis.rungs){
          const key=String(rung.levelPct);
          if(rung.crossed&&!state.triggered[key]){
            state.triggered[key]={...rung,triggeredAt:now};
            this.log('CANDLE_MOVE_TRIGGER',{side:rung.side,levelPct:rung.levelPct,
              shares:rung.shares,observedMove:rung.observedMove,requiredMove:rung.requiredMove});
          }
          const trigger=state.triggered[key];
          if(trigger&&!state.filled[key])await this.tryEnter(start,trigger);
          rung.triggered=Boolean(trigger);
          rung.filled=Boolean(state.filled[key]);
          rung.block=state.blocks[key]||null;
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
  }
  async tryEnter(start,trigger){
    if(Date.now()>=start+cfg.WINDOW_MS)return;
    const key=String(trigger.levelPct),state=this.rungState[start];
    const token=this.market.tokens[trigger.side],book=await md.getBook(token);
    const fill=sweep(book.asks,trigger.shares,cfg.MAX_ENTRY_ASK,cfg.MIN_ENTRY_ASK);
    if(!fill){state.blocks[key]=`Need ${trigger.shares} shares at asks from $${cfg.MIN_ENTRY_ASK.toFixed(2)} to $${cfg.MAX_ENTRY_ASK.toFixed(2)}`;return}
    const fee=feeFor(this.market.raw,fill.avg,fill.shares),total=fill.cost+fee;
    if(total>this.cash){state.blocks[key]='Insufficient demo cash';return}
    const p={id:`${start}-${trigger.side}-${trigger.levelPct}`,windowStart:start,marketId:this.market.id,slug:this.market.slug,
      title:this.market.title,side:trigger.side,triggerPct:trigger.levelPct,entryType:'CANDLE_MOVE',shares:fill.shares,
      avgEntry:fill.avg,cost:fill.cost,fees:fee,totalCost:total,status:'OPEN',openedAt:Date.now(),
      observedMove:trigger.observedMove,requiredMove:trigger.requiredMove,previousRange:trigger.previousRange};
    this.cash-=total;this.positions.unshift(p);state.filled[key]=p.id;delete state.blocks[key];this.status='position_open';
    this.log('PAPER_MOVE_ENTRY',{id:p.id,side:p.side,levelPct:p.triggerPct,shares:p.shares,avgEntry:p.avgEntry,cost:p.totalCost});
  }
  async trySettle(p){
    if(Date.now()<p.windowStart+cfg.WINDOW_MS)return;
    p.lastSettlementAttempt=Date.now();
    try{
      const m=await md.getMarket(p.marketId),won=payout(m,p.side);
      if(won==null){p.status='PENDING_OFFICIAL_RESULT';this.status='awaiting_official_result';return}
      p.payout=won;p.proceeds=won*p.shares;p.realizedPnl=p.proceeds-p.totalCost;
      p.status=won?'SETTLED_WIN':'SETTLED_LOSS';p.settledAt=Date.now();this.cash+=p.proceeds;
      this.log('PAPER_WICK_SETTLED',{id:p.id,status:p.status,pnl:p.realizedPnl});
    }catch(e){p.status='PENDING_OFFICIAL_RESULT';this.status='awaiting_official_result';}
  }
  snapshot(){
    const prior=this.market?aggregate(this.candles,cfg.WINDOW_MS)
      .filter(x=>x.t<this.market.start).slice(-3):[];
    return {now:Date.now(),mode:'DEMO ONLY',status:this.status,error:this.error,
       strategy:{market:'Polymarket BTC 15-minute UP/DOWN',capital:cfg.DEMO_CAPITAL,
         sharesPerTrigger:cfg.SHARES_PER_TRIGGER,maxTriggersPerWindow:cfg.TRIGGER_LEVELS_PCT.length,
         triggerLevelsPct:cfg.TRIGGER_LEVELS_PCT,minEntryAsk:cfg.MIN_ENTRY_ASK,maxEntryAsk:cfg.MAX_ENTRY_ASK,
        exit:'Hold to official market settlement',execution:'PAPER ONLY'},
      account:{capital:cfg.DEMO_CAPITAL,cash:this.cash,realizedPnl:this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0),
        openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_OFFICIAL_RESULT').length},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      livePrices:{marketSlug:this.market?.slug||null,updatedAt:Math.max(this.liveQuotes.UP.updatedAt||0,this.liveQuotes.DOWN.updatedAt||0)||null,
        UP:this.liveQuotes.UP,DOWN:this.liveQuotes.DOWN},
       scanner:{lastScanAt:this.lastScanAt,candleSource:'Kraken XBT/USD 1m; current 15m move compared with previous completed 15m candle',
        marketResolution:'Polymarket official outcome',analysis:this.analysis||null,
         previousCandles:prior,rungState:this.rungState[this.market?.start]||null},
      positions:this.positions.slice(0,50),events:this.events};
  }
  start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{note:'Demo-only BTC 15m candle-move ladder; no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={sweep,feeFor,payout,quoteFromBook};
