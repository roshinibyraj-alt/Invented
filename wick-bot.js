'use strict';

const cfg=require('./config');
const md=require('./wick-market-data');
const {detectWick}=require('./wick-core');

function levels(xs){return (xs||[]).map(x=>({price:Number(x.price),size:Number(x.size)}))
  .filter(x=>Number.isFinite(x.price)&&x.size>0).sort((a,b)=>a.price-b.price)}
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
function sweep(asks,qty,maxPrice){
  let left=qty,cost=0;
  for(const x of levels(asks)){
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
    this.error=null;this.market=null;this.candles=[];this.signal=null;this.lastMarketAt=0;
    this.lastCandlesAt=0;this.lastScanAt=null;this.signals={};this.traded={};this.running=false;
  }
  log(event,data={}){const e={ts:Date.now(),event,...data};this.events.unshift(e);this.events.length=Math.min(100,this.events.length);console.log('[wick] '+JSON.stringify(e))}
  async tick(){
    try{
      const now=Date.now(),start=Math.floor(now/cfg.WINDOW_MS)*cfg.WINDOW_MS;
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
      const analysis=detectWick({minuteCandles:this.candles,now,windowStart:start});
      this.analysis=analysis;this.lastScanAt=now;this.error=null;
      for(const p of this.positions){
        if((p.status==='OPEN'||p.status==='PENDING_OFFICIAL_RESULT')
          &&now>=p.windowStart+cfg.WINDOW_MS
          &&now-(p.lastSettlementAttempt||0)>=15000) await this.trySettle(p);
      }
      const old=this.positions.find(p=>p.windowStart===start);
      if(old){this.status=old.status==='OPEN'?'position_open':'scanning';await this.trySettle(old);return}
      if(analysis.signal&&!this.signals[start]){
        this.signals[start]=analysis.signal;
        this.log('WICK_SIGNAL',{side:analysis.signal.side,kind:analysis.signal.kind,
          entryType:analysis.signal.entryType,score:analysis.signal.score,threshold:analysis.signal.threshold});
      }
      const signal=this.signals[start];
      if(signal)await this.tryEnter(start,signal);
      this.status='scanning';
      if(!this.lastHeartbeat||now-this.lastHeartbeat>30000){this.lastHeartbeat=now;this.log('HEARTBEAT',{cash:this.cash,windowStart:start})}
    }catch(e){this.status='blocked_or_error';this.error=e.message;
      if(this.lastError!==e.message||Date.now()-this.lastErrorAt>30000){this.lastError=e.message;this.lastErrorAt=Date.now();this.log('SCAN_ERROR',{note:e.message})}}
  }
  async tryEnter(start,signal){
    if(Date.now()>=start+cfg.WINDOW_MS||this.traded[start])return;
    const token=this.market.tokens[signal.side],book=await md.getBook(token);
    const fill=sweep(book.asks,cfg.SHARES_PER_WINDOW,cfg.MAX_ENTRY_ASK);
    if(!fill){this.status='signal_waiting_for_ask_or_depth';return}
    const fee=feeFor(this.market.raw,fill.avg,fill.shares),total=fill.cost+fee;
    if(total>this.cash){this.status='insufficient_demo_cash';return}
    const p={id:`${start}-${signal.side}`,windowStart:start,marketId:this.market.id,slug:this.market.slug,
      title:this.market.title,side:signal.side,wick:signal.kind,entryType:signal.entryType,shares:fill.shares,
      avgEntry:fill.avg,cost:fill.cost,fees:fee,totalCost:total,status:'OPEN',openedAt:Date.now(),
      signalScore:signal.score,wickAtr:signal.normalized,threshold:signal.threshold};
    this.cash-=total;this.positions.unshift(p);this.traded[start]=true;this.status='position_open';
    this.log('PAPER_WICK_ENTRY',{id:p.id,side:p.side,shares:p.shares,avgEntry:p.avgEntry,cost:p.totalCost});
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
    return {now:Date.now(),mode:'DEMO ONLY',status:this.status,error:this.error,
      strategy:{market:'Polymarket BTC 15-minute UP/DOWN',capital:cfg.DEMO_CAPITAL,
        sharesPerWindow:cfg.SHARES_PER_WINDOW,maxEntryAsk:cfg.MAX_ENTRY_ASK,
        exit:'Hold to official market settlement',execution:'PAPER ONLY'},
      account:{capital:cfg.DEMO_CAPITAL,cash:this.cash,realizedPnl:this.positions.reduce((s,p)=>s+(p.realizedPnl||0),0),
        openPositions:this.positions.filter(p=>p.status==='OPEN'||p.status==='PENDING_OFFICIAL_RESULT').length},
      window:this.market?{title:this.market.title,slug:this.market.slug,start:this.market.start,end:this.market.end}:null,
      scanner:{lastScanAt:this.lastScanAt,candleSource:'Kraken XBT/USD 1m; signal candles aggregated to 15m and 1h',
        marketResolution:'Polymarket official outcome',analysis:this.analysis||null,latchedSignal:this.signals[this.market?.start]||null},
      positions:this.positions.slice(0,50),events:this.events};
  }
  start(){if(this.running)return;this.running=true;this.log('BOT_STARTED',{note:'Demo-only BTC 15m wick strategy; no live orders.'});
    const loop=async()=>{if(!this.running)return;await this.tick();if(this.running)this.timer=setTimeout(loop,cfg.POLL_INTERVAL_MS)};
    void loop();}
  stop(){this.running=false;clearTimeout(this.timer)}
}
module.exports=WickBot;
module.exports._test={sweep,feeFor,payout};
